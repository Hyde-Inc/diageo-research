"""Dagster declarative asset graph for the research pipeline.

Six pipeline stages are declared as Dagster ``@asset``s with explicit
upstream dependencies, plus a :class:`DynamicPartitionsDefinition` for
multiverse cells. The :class:`Definitions` object is the source of
truth for the pipeline DAG.

Asset bodies are **real adapters**, not stubs. Each one looks up the
live :class:`StageContext` from the process-local registry by partition
key (the cell's ``run_id``), then schedules the matching async stage
on the parent event loop via :func:`asyncio.run_coroutine_threadsafe`.
The asset body blocks the Dagster worker thread until the parent loop
finishes the stage. This keeps every async resource — the event bus,
the metered Anthropic client, contextvars — in the loop they were
constructed in, so we never get cross-loop httpx errors or queues
bound to dead loops.

How a cell flows::

    multiverse._execute_cell()                      [parent loop]
        → orchestrator.materialize_research_cell()  [parent loop]
            → register_stage_context(run_id, ctx)
            → asyncio.to_thread(dagster.materialize, ...)
                                                    [worker thread]
                → asset body (sync)
                    → run_coroutine_threadsafe(
                        stage_X(ctx), parent_loop)
                    → fut.result()                  [blocks worker thread]
                → ...
                                                    [parent loop runs each
                                                     coroutine in its own
                                                     event loop, with all
                                                     async I/O staying put]

The graph itself is the single source of truth for the FE workbench
mermaid view (via ``GET /assets/graph``) and is pinned by tests in
``tests/test_dagster_assets.py``.
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import json
import logging
import threading
from typing import TYPE_CHECKING, Any

from dagster import (
    AssetKey,
    AssetsDefinition,
    Definitions,
    DynamicPartitionsDefinition,
    MetadataValue,
    Output,
    asset,
)

from .pricing import run_ctx, stage_ctx
from .stages import (
    StageContext,
    stage_interviews,
    stage_outline,
    stage_personas,
    stage_question_analysis,
    stage_synthesis,
    stage_verifier,
)

if TYPE_CHECKING:  # pragma: no cover
    pass

logger = logging.getLogger(__name__)


cell_partitions = DynamicPartitionsDefinition(name="study_cells")
"""One Dagster partition per multiverse cell.

Dynamic so studies can introduce a new cell mid-flight without a code
redeploy. Partition key == ``SpecCell.run_id`` (which is unique).
"""


# ----------------------------------------------- Source of truth for the graph
#
# (key, label, [upstream keys], description)
#
# Tests assert that Dagster's introspected graph matches this spec.

STAGE_SPEC: list[tuple[str, str, list[str], str]] = [
    (
        "question_analysis",
        "Question analysis",
        [],
        "Score question complexity, derive lens seeds, and recommend panel size (Opus).",
    ),
    (
        "personas",
        "Persona panel",
        ["question_analysis"],
        "Generate the analyst panel with persona-specific checklists (Opus).",
    ),
    (
        "outline",
        "Outline",
        ["question_analysis", "personas"],
        "Draft the seed outline and assign sections across personas (Opus then Sonnet).",
    ),
    (
        "interviews",
        "Interviews",
        ["personas", "outline"],
        "Per-persona STORM interviews with parallel tool dispatch; "
        "per-persona sub-reports with headline claims (Sonnet).",
    ),
    (
        "verifier",
        "Verifier",
        ["interviews"],
        "Re-execute SQL/web citations in parallel to flag broken provenance.",
    ),
    (
        "synthesis",
        "Synthesis",
        ["outline", "interviews", "verifier"],
        "Final brief: parallel section writers + charts + evidence appendix (Opus).",
    ),
]

STAGE_LABEL: dict[str, str] = {key: label for key, label, _, _ in STAGE_SPEC}
STAGE_DESCRIPTION: dict[str, str] = {key: desc for key, _, _, desc in STAGE_SPEC}


# --------------------------------------- Process-local StageContext registry
#
# Asset bodies look up the live StageContext for the partition they're
# materializing. Because Dagster runs the asset body in a worker thread
# (we use asyncio.to_thread in the parent loop), we need a thread-safe
# handle. Plain dict + lock is enough — the registry is hot only during
# the few seconds of materialize().

_REGISTRY: dict[str, StageContext] = {}
_REGISTRY_LOCK = threading.Lock()


def register_stage_context(run_id: str, ctx: StageContext) -> None:
    """Make ``ctx`` discoverable by the asset bodies for ``run_id``."""
    with _REGISTRY_LOCK:
        _REGISTRY[run_id] = ctx


def unregister_stage_context(run_id: str) -> None:
    """Remove the StageContext after the cell finishes (or fails)."""
    with _REGISTRY_LOCK:
        _REGISTRY.pop(run_id, None)


def _get_stage_context(run_id: str) -> StageContext:
    with _REGISTRY_LOCK:
        ctx = _REGISTRY.get(run_id)
    if ctx is None:
        raise RuntimeError(
            f"No StageContext registered for partition_key {run_id!r}. "
            f"Asset bodies require materialize_research_cell() to register a "
            f"context first; call from there rather than dagster.materialize "
            f"directly."
        )
    return ctx


def _run_stage_on_parent_loop(
    ctx: StageContext,
    coro_factory: Any,
    *,
    stage_name: str,
) -> None:
    """Schedule ``coro_factory(ctx)`` on the parent loop and block.

    The coroutine factory takes the context and returns the awaitable
    stage. We schedule via :func:`asyncio.run_coroutine_threadsafe` so
    the parent loop's bus, anthropic client, and contextvars all remain
    in scope. Errors propagate as ordinary exceptions from
    ``Future.result()`` so Dagster sees a normal step failure.

    ``run_ctx(run_id)`` is re-entered from inside the coroutine (via the
    wrapper here) so cost attribution works even though the parent
    loop's run_token is bound to a different task.
    """
    parent_loop = ctx.parent_loop
    if parent_loop is None or parent_loop.is_closed():
        raise RuntimeError(
            f"Parent event loop is unavailable for stage {stage_name!r}; "
            "materialize_research_cell must be called while the parent loop is running."
        )

    async def _runner() -> None:
        with run_ctx(ctx.run_id):
            await coro_factory(ctx)

    fut = asyncio.run_coroutine_threadsafe(_runner(), parent_loop)
    # No timeout: stages can take many minutes (Sonnet/Opus calls). The
    # parent's BudgetExceeded path or a cell-level cancellation will
    # propagate exceptions before this hangs forever.
    fut.result()


# ------------------------------------------------------------------ Assets
#
# Asset bodies are sync (not async). They run on Dagster's worker thread
# and use _run_stage_on_parent_loop to bounce the actual work back onto
# the parent loop where the bus/client live. The Output return wraps the
# stage's outputs as Dagster metadata so they show up in
# AssetMaterialization records.


def _stage_metadata_payload(ctx: StageContext, stage_name: str) -> dict[str, Any]:
    """Pure-Python (no Dagster types) snapshot of a stage's outputs.

    Used both to populate the Dagster :class:`MetadataValue` map (so
    AssetMaterialization records carry the full picture) and to persist
    a JSONL receipt to disk so the workbench can render the same data
    without running a Dagster webserver.
    """
    payload: dict[str, Any] = {
        "run_id": ctx.run_id,
        "stage": stage_name,
        "spent_usd": round(ctx.cost_tracker.cost_usd, 6),
        "n_calls": int(ctx.cost_tracker.breakdown.n_calls),
    }
    if stage_name == "question_analysis" and ctx.plan is not None:
        payload["complexity"] = ctx.plan.complexity
        payload["complexity_score"] = int(ctx.plan.complexity_score)
        payload["recommended_personas"] = int(ctx.plan.recommended_personas)
    elif stage_name == "personas":
        payload["n_personas"] = int(len(ctx.personas))
    elif stage_name == "outline":
        payload["n_sections"] = int(len(ctx.seed_sections))
    elif stage_name == "interviews":
        payload["n_subreports"] = int(len(ctx.sub_reports))
        payload["total_citations"] = int(sum(len(s.citations) for s in ctx.sub_reports))
    elif stage_name == "verifier":
        payload["verified"] = int(ctx.verified_count)
        payload["flagged"] = int(ctx.flagged_count)
    elif stage_name == "synthesis" and ctx.final is not None:
        payload["n_sections"] = int(len(ctx.final.outline))
        payload["n_citations"] = int(len(ctx.final.citations))
        payload["markdown_len"] = int(len(ctx.final.markdown))
    return payload


def _asset_metadata(ctx: StageContext, stage_name: str) -> dict[str, Any]:
    """Wrap the pure-Python payload in Dagster :class:`MetadataValue`s.

    Mirrors what the run manifest captures so Dagster's lineage UI tells
    the same story as our ``runs/<run_id>/manifest.json``.
    """
    payload = _stage_metadata_payload(ctx, stage_name)
    md: dict[str, Any] = {}
    for k, v in payload.items():
        if isinstance(v, bool):
            md[k] = MetadataValue.bool(v)
        elif isinstance(v, int):
            md[k] = MetadataValue.int(v)
        elif isinstance(v, float):
            md[k] = MetadataValue.float(v)
        else:
            md[k] = MetadataValue.text(str(v))
    return md


# JSONL receipt of every asset materialization. Lives at
# ``runs/<run_id>/dagster_materializations.jsonl``. One line per stage,
# captured atomically inside the same lock as the metadata renderer so a
# concurrent reader can't see a half-flushed line. The workbench reads
# this via ``GET /runs/{run_id}/materializations`` to power the lineage
# drawer in the DAG view.

_MATERIALIZATIONS_FILE = "dagster_materializations.jsonl"
_MATERIALIZATIONS_LOCK = threading.Lock()


def _record_materialization(ctx: StageContext, stage_name: str) -> dict[str, Any]:
    """Persist one stage's materialization to disk and return the record.

    Captures: timestamp, run_id (== partition key), stage, spend, model,
    n_calls, plus stage-specific output counts. Cross-references the
    matching :class:`ManifestWriter` entry for the SHA-256 input/output
    hashes so the FE can show 'this output's hash matches what was
    produced last time' replays.
    """
    payload = _stage_metadata_payload(ctx, stage_name)
    payload["asset_key"] = stage_name
    payload["partition_key"] = ctx.run_id
    payload["timestamp"] = _dt.datetime.now(tz=_dt.timezone.utc).isoformat()

    # Pull hashes from the manifest if they're already written. The
    # manifest writer gets called inside the stage function before the
    # asset body returns, so by the time we run, it should be on disk.
    try:
        manifest_path = ctx.run_dir / "manifest.json"
        if manifest_path.exists():
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            for stage_entry in (data.get("stages") or []):
                if stage_entry.get("stage") == stage_name:
                    payload["input_hash"] = stage_entry.get("input_hash")
                    payload["output_hash"] = stage_entry.get("output_hash")
                    payload["prompt_hash"] = stage_entry.get("prompt_hash")
                    payload["code_hash"] = stage_entry.get("code_hash")
                    payload["model_id"] = stage_entry.get("model_id")
                    payload["elapsed_s"] = stage_entry.get("elapsed_s")
                    break
    except Exception:  # noqa: BLE001
        # Receipts are best-effort; never break a stage on a missing manifest.
        logger.debug("manifest read failed during materialization receipt", exc_info=True)

    with _MATERIALIZATIONS_LOCK:
        path = ctx.run_dir / _MATERIALIZATIONS_FILE
        try:
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(payload, default=str) + "\n")
        except Exception:  # noqa: BLE001
            logger.exception("failed to write materialization receipt")
    return payload


@asset(
    partitions_def=cell_partitions,
    description=STAGE_DESCRIPTION["question_analysis"],
    group_name="research_pipeline",
)
def question_analysis(context) -> Output[dict[str, Any]]:
    ctx = _get_stage_context(context.partition_key)
    with stage_ctx("question_analysis"):
        _run_stage_on_parent_loop(ctx, stage_question_analysis, stage_name="question_analysis")
    _record_materialization(ctx, "question_analysis")
    return Output(
        value={"complexity": ctx.plan.complexity if ctx.plan else None},
        metadata=_asset_metadata(ctx, "question_analysis"),
    )


@asset(
    partitions_def=cell_partitions,
    deps=[question_analysis],
    description=STAGE_DESCRIPTION["personas"],
    group_name="research_pipeline",
)
def personas(context) -> Output[dict[str, Any]]:
    ctx = _get_stage_context(context.partition_key)
    with stage_ctx("personas"):
        _run_stage_on_parent_loop(ctx, stage_personas, stage_name="personas")
    _record_materialization(ctx, "personas")
    return Output(
        value={"n_personas": len(ctx.personas)},
        metadata=_asset_metadata(ctx, "personas"),
    )


@asset(
    partitions_def=cell_partitions,
    deps=[question_analysis, personas],
    description=STAGE_DESCRIPTION["outline"],
    group_name="research_pipeline",
)
def outline(context) -> Output[dict[str, Any]]:
    ctx = _get_stage_context(context.partition_key)
    with stage_ctx("outline"):
        _run_stage_on_parent_loop(ctx, stage_outline, stage_name="outline")
    _record_materialization(ctx, "outline")
    return Output(
        value={"n_sections": len(ctx.seed_sections)},
        metadata=_asset_metadata(ctx, "outline"),
    )


@asset(
    partitions_def=cell_partitions,
    deps=[personas, outline],
    description=STAGE_DESCRIPTION["interviews"],
    group_name="research_pipeline",
)
def interviews(context) -> Output[dict[str, Any]]:
    ctx = _get_stage_context(context.partition_key)
    with stage_ctx("interviews"):
        _run_stage_on_parent_loop(ctx, stage_interviews, stage_name="interviews")
    _record_materialization(ctx, "interviews")
    return Output(
        value={"n_subreports": len(ctx.sub_reports)},
        metadata=_asset_metadata(ctx, "interviews"),
    )


@asset(
    partitions_def=cell_partitions,
    deps=[interviews],
    description=STAGE_DESCRIPTION["verifier"],
    group_name="research_pipeline",
)
def verifier(context) -> Output[dict[str, Any]]:
    ctx = _get_stage_context(context.partition_key)
    with stage_ctx("verifier"):
        _run_stage_on_parent_loop(ctx, stage_verifier, stage_name="verifier")
    _record_materialization(ctx, "verifier")
    return Output(
        value={"verified": ctx.verified_count, "flagged": ctx.flagged_count},
        metadata=_asset_metadata(ctx, "verifier"),
    )


@asset(
    partitions_def=cell_partitions,
    deps=[outline, interviews, verifier],
    description=STAGE_DESCRIPTION["synthesis"],
    group_name="research_pipeline",
)
def synthesis(context) -> Output[dict[str, Any]]:
    ctx = _get_stage_context(context.partition_key)
    with stage_ctx("synthesis"):
        _run_stage_on_parent_loop(ctx, stage_synthesis, stage_name="synthesis")
    _record_materialization(ctx, "synthesis")
    payload: dict[str, Any] = {}
    if ctx.final is not None:
        payload = {
            "n_sections": len(ctx.final.outline),
            "n_citations": len(ctx.final.citations),
        }
    return Output(value=payload, metadata=_asset_metadata(ctx, "synthesis"))


ALL_ASSETS: list[AssetsDefinition] = [
    question_analysis,
    personas,
    outline,
    interviews,
    verifier,
    synthesis,
]


defs = Definitions(assets=ALL_ASSETS)
"""Module-level :class:`Definitions` so the FE / tests can introspect."""


# -------------------------------------------------------- Graph introspection


def _asset_key_simple(key: AssetKey) -> str:
    """Render an :class:`AssetKey` as its leaf path component."""
    return key.path[-1] if key.path else key.to_user_string()


def asset_graph_json() -> dict[str, Any]:
    """Return the declared asset graph as ``{nodes, edges, partition_set}``.

    Drives the workbench mermaid view. Node order matches ``STAGE_SPEC``
    so the rendered DAG is stable across page loads.
    """
    asset_graph = defs.resolve_asset_graph()
    nodes: list[dict[str, Any]] = []
    edges_seen: set[tuple[str, str]] = set()
    edges: list[dict[str, str]] = []

    declared_order = [key for key, *_ in STAGE_SPEC]

    for stage_key in declared_order:
        asset_key = AssetKey([stage_key])
        node = asset_graph.get(asset_key)
        parent_simple = sorted(_asset_key_simple(p) for p in node.parent_keys)
        nodes.append(
            {
                "id": stage_key,
                "label": STAGE_LABEL.get(stage_key, stage_key),
                "description": STAGE_DESCRIPTION.get(stage_key, ""),
                "deps": parent_simple,
                "group": "research_pipeline",
            }
        )
        for parent in parent_simple:
            edge = (parent, stage_key)
            if edge not in edges_seen:
                edges_seen.add(edge)
                edges.append({"from": parent, "to": stage_key})

    return {
        "nodes": nodes,
        "edges": edges,
        "partition_set": cell_partitions.name,
    }


__all__ = [
    "ALL_ASSETS",
    "STAGE_SPEC",
    "STAGE_LABEL",
    "STAGE_DESCRIPTION",
    "asset_graph_json",
    "cell_partitions",
    "defs",
    "interviews",
    "outline",
    "personas",
    "question_analysis",
    "register_stage_context",
    "synthesis",
    "unregister_stage_context",
    "verifier",
]

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
    AssetMaterialization,
    AssetsDefinition,
    DagsterInstance,
    Definitions,
    DynamicPartitionsDefinition,
    MetadataValue,
    Output,
    asset,
)

from . import keys as _keys
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


# ----------------------------------------------------------- Cell-level asset
#
# The six stage assets above are intentionally scoped to one cell run.
# Their partition keys are study-scoped (``study_<sid>_<cell_id>``) so a
# rerun of the same axes in a different study creates a different
# partition and a fresh materialization. That keeps each study's data
# lineage isolated, but it also means stages cannot be cached across
# studies.
#
# To unlock cross-study reuse we additionally emit a content-addressed
# ``research_cell`` ``AssetMaterialization`` after the cell finishes:
#
#     AssetKey(["research_cell", question_hash, axes_signature])
#
# The key is deterministic in the (question, axes, code_version,
# prompt_version) tuple — see :mod:`diageo_research.keys`. Same inputs
# always land on the same Dagster asset, so Dagit can show "this cell
# already ran on 2026-05-26; spend was $0.47" the next time a study
# requests it. We emit it as a runless event (via
# :meth:`DagsterInstance.report_runless_asset_event`) so it gets indexed
# in the persistent event log alongside the per-stage materializations
# that ``materialize()`` writes.
#
# The dynamic partition set ``research_cells`` carries the per-cell
# signature so Dagit's asset detail view can group historical
# materializations by intent.

RESEARCH_CELL_PARTITIONS = DynamicPartitionsDefinition(name="research_cells")
"""Partition set used by the content-addressed ``research_cell`` event.

Partition keys are the readable cell signature returned by
:func:`diageo_research.keys.cell_signature` (``q-…__a-…__c-…__p-…__h-…``).
The partition set name is intentionally distinct from ``study_cells`` so
the existing per-stage materializations (which Dagit indexes by run_id)
remain unambiguously scoped to one study.
"""


CELL_MATERIALIZATION_FILE = "cell_materialization.json"


def build_cell_metadata(
    *,
    question: str,
    axes: dict[str, str] | None,
    status: str,
    wall_time_s: float,
    cost_tracker: Any | None = None,
    produced_paths: list[str] | None = None,
    extras: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Pure-Python (JSON-safe) metadata bundle for one cell materialization.

    Used both as the seed for the Dagster :class:`MaterializeResult` (so
    Dagit renders the receipt on the asset detail page) and as the body
    of the ``cell_materialization.json`` we persist under ``runs/<run_id>/``
    for back-compat with the file-based workbench reader.
    """
    summary = _keys.metadata_summary(question=question, axes=axes)
    summary["status"] = str(status)
    summary["wall_time_s"] = round(float(wall_time_s), 3)
    summary["produced_paths"] = list(produced_paths or [])
    if cost_tracker is not None:
        try:
            summary["cost_usd"] = round(float(cost_tracker.cost_usd), 6)
            breakdown = cost_tracker.breakdown
            summary["cost_tokens"] = {
                "input": int(getattr(breakdown, "input_tokens", 0) or 0),
                "cached_input": int(
                    getattr(breakdown, "cached_input_tokens", 0) or 0
                ),
                "output": int(getattr(breakdown, "output_tokens", 0) or 0),
                "n_calls": int(getattr(breakdown, "n_calls", 0) or 0),
            }
        except Exception:  # noqa: BLE001
            logger.debug("cost tracker introspection failed", exc_info=True)
    if extras:
        summary.update(extras)
    return summary


def _wrap_metadata_for_dagster(payload: dict[str, Any]) -> dict[str, Any]:
    """Translate a JSON-safe metadata dict to Dagster :class:`MetadataValue`s.

    Mappings and lists land as JSON metadata so they keep their shape
    in the Dagit asset detail view. Strings are intentionally truncated
    so long questions don't break the UI's metadata table.
    """
    md: dict[str, Any] = {}
    for k, v in payload.items():
        if isinstance(v, bool):
            md[k] = MetadataValue.bool(v)
        elif isinstance(v, int):
            md[k] = MetadataValue.int(v)
        elif isinstance(v, float):
            md[k] = MetadataValue.float(v)
        elif isinstance(v, (list, dict)):
            md[k] = MetadataValue.json(v)
        else:
            md[k] = MetadataValue.text(str(v))
    return md


def emit_cell_materialization(
    instance: DagsterInstance,
    *,
    question: str,
    axes: dict[str, str] | None,
    run_dir: Any,
    status: str,
    wall_time_s: float,
    cost_tracker: Any | None = None,
    produced_paths: list[str] | None = None,
    extras: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Emit + persist one cell-level materialization receipt.

    Does three things:

    1. Builds a deterministic asset key
       ``["research_cell", question_hash, axes_signature]`` and a readable
       partition key ``cell_signature(question, axes)``.
    2. Reports a runless :class:`AssetMaterialization` so it shows up in
       the persistent Dagster instance under both the dynamic asset key
       and the ``research_cells`` partition set.
    3. Persists the same JSON body to ``runs/<run_id>/cell_materialization.json``
       so the file-based workbench reader keeps working without Dagit
       running.
    """
    payload = build_cell_metadata(
        question=question,
        axes=axes,
        status=status,
        wall_time_s=wall_time_s,
        cost_tracker=cost_tracker,
        produced_paths=produced_paths,
        extras=extras,
    )
    asset_key_path = payload["asset_key_path"]
    partition_key = payload["cell_signature"]

    # Persist to disk first — that side never fails, so the file-based
    # workbench always has a record even if Dagster's event log is
    # momentarily unavailable.
    try:
        from pathlib import Path as _Path

        run_dir_path = _Path(run_dir)
        run_dir_path.mkdir(parents=True, exist_ok=True)
        out_path = run_dir_path / CELL_MATERIALIZATION_FILE
        out_path.write_text(
            json.dumps(payload, indent=2, default=str), encoding="utf-8"
        )
        payload["materialization_path"] = str(out_path)
    except Exception:  # noqa: BLE001
        logger.exception(
            "cell materialization receipt write failed for run_dir %s", run_dir
        )

    try:
        instance.add_dynamic_partitions(
            RESEARCH_CELL_PARTITIONS.name, [partition_key]
        )
    except Exception:  # noqa: BLE001
        logger.debug("add_dynamic_partitions failed", exc_info=True)

    try:
        instance.report_runless_asset_event(
            AssetMaterialization(
                asset_key=asset_key_path,
                partition=partition_key,
                description=(
                    f"Cell brief for question_hash={payload['question_hash']} "
                    f"axes={payload['axes_signature']!r} "
                    f"({status}, {wall_time_s:.1f}s)"
                ),
                metadata=_wrap_metadata_for_dagster(payload),
            )
        )
    except Exception:  # noqa: BLE001
        logger.exception("emit_cell_materialization: runless event failed")

    return payload


def list_cell_materializations(
    instance: DagsterInstance, *, limit: int = 50
) -> list[dict[str, Any]]:
    """List the latest content-addressed cell materializations.

    Walks every partition key registered against ``research_cells`` and
    queries the latest materialization per key, newest first. Used by
    the ``GET /assets`` listing endpoint.
    """
    try:
        partition_keys = list(
            instance.get_dynamic_partitions(RESEARCH_CELL_PARTITIONS.name)
        )
    except Exception:  # noqa: BLE001
        logger.debug("get_dynamic_partitions(research_cells) failed", exc_info=True)
        partition_keys = []
    out: list[dict[str, Any]] = []
    for pk in partition_keys:
        records = _fetch_records_for_partition(instance, pk, limit=1)
        if not records:
            continue
        out.append(_summarize_record(records[0]))
    out.sort(key=lambda r: r.get("timestamp", ""), reverse=True)
    return out[:limit]


def _fetch_records_for_partition(
    instance: DagsterInstance, partition_key: str, *, limit: int = 25
) -> list[Any]:
    """Fetch materialization records for a given ``research_cells`` partition.

    Dagster doesn't expose a "fetch by partition only" call without an
    asset key, so we enumerate over the small set of asset keys we know
    can land on ``research_cells`` partitions. In practice this is a
    one-element set per partition (the content-addressed key path), but
    we support multiple to keep the API tolerant.
    """
    # The content-addressed asset key for a given partition is
    # derivable from the partition's own signature — but we don't have
    # the question/axes here. Instead we rely on the partition key
    # itself being unique across asset keys (it is — ``cell_signature``
    # already encodes question_hash + axes), and ask Dagster for any
    # asset key materialized against that partition by scanning the
    # event log directly.
    try:
        # ``fetch_materializations`` requires an asset_key; we don't
        # have one outside the materialization metadata. So we go via
        # ``all_asset_keys`` and filter by prefix.
        all_keys = [
            k
            for k in instance.all_asset_keys()
            if k.path and k.path[0] == _keys.CELL_ASSET_KEY_PREFIX
        ]
    except Exception:  # noqa: BLE001
        return []
    matches: list[Any] = []
    for key in all_keys:
        try:
            res = instance.fetch_materializations(
                records_filter=key, limit=limit
            )
            for rec in res.records:
                if (
                    getattr(rec, "partition_key", None) == partition_key
                    or _record_partition(rec) == partition_key
                ):
                    matches.append(rec)
        except Exception:  # noqa: BLE001
            continue
    matches.sort(key=lambda r: _record_timestamp(r), reverse=True)
    return matches[:limit]


def _record_partition(record: Any) -> str | None:
    """Try a few well-known accessors to pull the partition key off a record."""
    pk = getattr(record, "partition_key", None)
    if pk:
        return pk
    entry = getattr(record, "event_log_entry", None)
    if entry is None:
        return None
    dagster_event = getattr(entry, "dagster_event", None)
    if dagster_event is None:
        return None
    esd = getattr(dagster_event, "event_specific_data", None)
    if esd is None:
        return None
    mat = getattr(esd, "materialization", None)
    if mat is None:
        return None
    return getattr(mat, "partition", None)


def _record_timestamp(record: Any) -> float:
    """Pull a sortable timestamp off a materialization record."""
    ts = getattr(record, "timestamp", None)
    if isinstance(ts, (int, float)):
        return float(ts)
    entry = getattr(record, "event_log_entry", None)
    if entry is not None:
        ts2 = getattr(entry, "timestamp", None)
        if isinstance(ts2, (int, float)):
            return float(ts2)
    return 0.0


def _summarize_record(record: Any) -> dict[str, Any]:
    """Pluck the user-facing fields off one materialization record."""
    out: dict[str, Any] = {}
    entry = getattr(record, "event_log_entry", None)
    if entry is None:
        return out
    dagster_event = getattr(entry, "dagster_event", None)
    if dagster_event is None:
        return out
    esd = getattr(dagster_event, "event_specific_data", None)
    mat = getattr(esd, "materialization", None) if esd is not None else None
    if mat is None:
        return out

    asset_key = mat.asset_key
    out["asset_key"] = list(asset_key.path)
    out["asset_key_encoded"] = _keys.encode_asset_key(asset_key.path)
    out["partition_key"] = mat.partition
    out["description"] = mat.description or ""
    out["timestamp"] = _record_timestamp(record)
    out["run_id"] = getattr(entry, "run_id", None) or ""

    md: dict[str, Any] = {}
    for k, v in (mat.metadata or {}).items():
        try:
            md[str(k)] = getattr(v, "value", v)
        except Exception:  # noqa: BLE001
            md[str(k)] = str(v)
    out["metadata"] = md
    return out


def fetch_asset_history(
    instance: DagsterInstance,
    *,
    asset_key_path: list[str],
    limit: int = 25,
) -> list[dict[str, Any]]:
    """Last N materializations for a given asset key, newest first."""
    try:
        res = instance.fetch_materializations(
            records_filter=AssetKey(asset_key_path), limit=limit
        )
        records = list(res.records)
    except Exception:  # noqa: BLE001
        return []
    records.sort(key=_record_timestamp, reverse=True)
    return [_summarize_record(r) for r in records]


def asset_lineage(asset_key_path: list[str]) -> dict[str, list[list[str]]]:
    """Return declared upstream + downstream asset key paths for ``asset_key``.

    Reads the declared graph from :data:`defs`. For ad-hoc asset keys
    that aren't declared (the content-addressed ``research_cell``
    family), lineage is best-effort: upstream is the synthesis stage
    (the brief's immediate producer), downstream is empty.
    """
    target = AssetKey(asset_key_path)
    asset_graph = defs.resolve_asset_graph()
    node = None
    try:
        node = asset_graph.get(target)
    except (KeyError, Exception):  # noqa: BLE001
        node = None
    if node is not None:
        upstream = [list(parent.path) for parent in node.parent_keys]
        downstream = [list(child.path) for child in node.child_keys]
        return {"upstream": upstream, "downstream": downstream}

    if asset_key_path and asset_key_path[0] == _keys.CELL_ASSET_KEY_PREFIX:
        return {
            "upstream": [["synthesis"]],
            "downstream": [],
        }
    return {"upstream": [], "downstream": []}


__all__ = [
    "ALL_ASSETS",
    "CELL_MATERIALIZATION_FILE",
    "RESEARCH_CELL_PARTITIONS",
    "STAGE_SPEC",
    "STAGE_LABEL",
    "STAGE_DESCRIPTION",
    "asset_graph_json",
    "asset_lineage",
    "build_cell_metadata",
    "cell_partitions",
    "defs",
    "emit_cell_materialization",
    "fetch_asset_history",
    "interviews",
    "list_cell_materializations",
    "outline",
    "personas",
    "question_analysis",
    "register_stage_context",
    "synthesis",
    "unregister_stage_context",
    "verifier",
]

"""FastAPI app — single-question SSE streams + multiverse Study endpoints.

Endpoints:

Single research run (existing — kept for back-compat):
  POST   /research                    start a single run
  GET    /research/{run_id}/stream    SSE for that run
  GET    /research/{run_id}/report    final.json
  GET    /research/{run_id}/state     in-memory RunState

Hypothesis Workbench (multiverse / studies):
  POST   /studies                     start a multiverse study from a posted spec
  GET    /studies                     list studies (newest first)
  GET    /studies/{study_id}          parent study state
  GET    /studies/{study_id}/spec_curve  rebuilt-on-demand spec curve JSON
  GET    /studies/{study_id}/stream   multiplexed SSE over all child cells
  GET    /studies/samples             list YAML specs in samples/ for the UI

Per-run inspection (used by the workbench asset viewer):
  GET    /runs/{run_id}/state         RunState (also accepts cell run_ids)
  GET    /runs/{run_id}/manifest      provenance manifest
  GET    /runs/{run_id}/stages        list of stage files (slug + size)
  GET    /runs/{run_id}/stages/{slug} markdown body of a single stage file
  GET    /runs/{run_id}/final         final.md (fallback to final.json)
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

import yaml
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError
from sse_starlette.sse import EventSourceResponse

from ..ask import AskAnswer, ask_study
from ..evidence_trace import build_evidence_trace
from ..research_view import build_research_summary
from ..study_plan import (
    load_study_spec,
    persist_revision,
    pick_proof_cell,
    revision_from_instruction,
    rerun_single_cell,
)
from .. import keys as _keys
from ..config import get_settings
from ..dagster_assets import (
    asset_graph_json,
    asset_lineage,
    fetch_asset_history,
    list_cell_materializations,
)
from ..events import EventBus, create_bus, get_bus
from ..granular_assets import (
    COUNTERFACTUAL_ASSET_PREFIX,
    CounterfactualAsset,
    DECISION_ASSET_PREFIX,
    DecisionAsset,
    GRANULAR_PREFIXES,
    GROWTH_DRIVER_ASSET_PREFIX,
    GrowthDriverAsset,
    IN_YEAR_QUERY_ASSET_PREFIX,
    InYearQueryAsset,
    TASK_ASSET_PREFIX,
    TaskAsset,
    compute_decision_in_year_diff,
    compute_decision_snapshot,
    content_id_counterfactual,
    content_id_decision,
    content_id_in_year_query,
    content_id_task,
    emit_counterfactual_materialization,
    emit_decision_materialization,
    emit_growth_driver_materialization,
    emit_in_year_query_materialization,
    emit_task_materialization,
    fetch_claims_for_cell,
    granular_asset_lineage,
    kind_for_asset_key,
    list_granular_assets,
    list_persisted_assets,
    load_decision_asset,
)
from ..manifest import read_manifest
from ..models import RunState
from ..multiverse import (
    StudySpec,
    list_studies,
    load_spec,
    new_study_id,
    read_study,
    run_study,
)
from ..multiverse_report import build_spec_curve, write_spec_curve
from ..orchestrator import (
    _resolve_dagster_instance,
    materialize_research_cell,
    new_run_id,
    run_research,
)
from ..prereg import PreregError
from ..run_writer import list_stage_files

logger = logging.getLogger(__name__)

app = FastAPI(title="Diageo Research — Hypothesis Workbench")

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
SAMPLES_DIR = Path(__file__).parents[3] / "samples"

_runs: dict[str, RunState] = {}
_tasks: dict[str, asyncio.Task[Any]] = {}
_studies: dict[str, asyncio.Task[Any]] = {}


# -------------------------------------------------------- Models for requests


class ResearchRequest(BaseModel):
    question: str = Field(..., min_length=1)
    personas: int | None = Field(default=None, ge=1, le=8)
    turns: int | None = Field(default=None, ge=1, le=12)


class StudyRequest(BaseModel):
    """Either provide an inline spec or reference a sample by name."""

    spec: dict[str, Any] | None = None
    sample: str | None = None


class AskRequest(BaseModel):
    """Body for POST /studies/{study_id}/ask.

    ``scenario_id`` is optional. When set, the answerer narrows context to
    that cell and treats the other cells as background colour.
    """

    question: str = Field(..., min_length=1)
    scenario_id: str | None = None


class AskCitation(BaseModel):
    source: str
    snippet: str
    link: str | None = None


class AskResponse(BaseModel):
    answer: str
    citations: list[AskCitation] = Field(default_factory=list)
    unknowns: list[str] = Field(default_factory=list)


class PlanReviseRequest(BaseModel):
    instruction: str = Field(..., min_length=1)
    apply: bool = False
    rerun: bool = False


class PlanReviseResponse(BaseModel):
    instruction: str
    diff_lines: list[str] = Field(default_factory=list)
    spec_before: dict[str, Any] = Field(default_factory=dict)
    spec_after: dict[str, Any] = Field(default_factory=dict)
    applied: bool = False
    queued_cell_id: str | None = None
    queued_run_id: str | None = None


class TraceStepModel(BaseModel):
    kind: str
    title: str
    detail: str
    asset_ref: str | None = None
    timestamp: str | None = None
    code_version: str | None = None
    prompt_version: str | None = None


class TraceResponse(BaseModel):
    trace_id: str
    label: str
    value_display: str
    steps: list[TraceStepModel] = Field(default_factory=list)
    run_id: str | None = None
    cluster_id: int | None = None
    illustrative: bool = False


# ------------------------------------------------------------- Static / index


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# ----------------------------------------------------- Dagster declared graph
#
# The workbench FE renders the per-cell DAG from this graph rather than a
# hardcoded ``STAGE_ORDER`` list. The graph is the source of truth declared
# in ``diageo_research/dagster_assets.py`` and validated by tests.


@app.get("/assets/graph")
def get_assets_graph() -> dict[str, Any]:
    """Return the declared Dagster asset graph as ``{nodes, edges}``.

    See :func:`diageo_research.dagster_assets.asset_graph_json` for the
    payload shape. Used by the workbench to render real lineage in the
    DAG view (mermaid edges follow declared deps, not a sequential
    list).
    """
    return asset_graph_json()


# ---------------------------------------------- Asset read-path (Dagster)
#
# These endpoints surface materialization history that lives in the
# persistent Dagster instance (``.dagster_home``). They sit alongside
# the file-based ``/runs/.../*`` endpoints rather than replacing them —
# the FE keeps reading the file-based artefacts for the existing panes
# and pulls from these endpoints when it needs lineage, history, or a
# trigger-new-run hook.
#
# Asset keys travel through the URL as a base64-encoded JSON list (see
# :func:`diageo_research.keys.encode_asset_key`). The encoding keeps
# arbitrary path components (``research_cell/<hash>/<sig>``) safe in a
# URL without us needing to invent a string-escape scheme.


class AssetMaterializeRequest(BaseModel):
    """Body for ``POST /assets/{key}/materialize``.

    For declared partitioned assets, ``partition_key`` is mandatory so
    we know which partition to re-run. For the content-addressed
    ``research_cell`` family the body also needs ``question`` and
    ``axes`` so we can rebuild the stage context — past materializations
    don't carry the full input (just the hashes), so we ask the caller
    to re-supply them.
    """

    partition_key: str | None = None
    question: str | None = None
    axes: dict[str, str] | None = None
    n_personas: int | None = Field(default=None, ge=1, le=8)
    max_turns: int | None = Field(default=None, ge=1, le=12)
    max_cost_usd: float | None = Field(default=None, ge=0)


_asset_materialize_tasks: dict[str, asyncio.Task[Any]] = {}


def _safe_decode_asset_key(key_b64: str) -> list[str]:
    try:
        return _keys.decode_asset_key(key_b64)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"bad asset key: {e}")


# Workbench-facing labels for the asset kinds the FE expects to filter by.
# ``declared`` covers the six pipeline stage assets ("question_analysis",
# "personas", ...). ``cell`` covers the content-addressed brief assets
# under ``research_cells``. The remaining kinds correspond to the
# granular runless materializations emitted from
# :mod:`diageo_research.granular_assets` during the interview and
# synthesis stages.
ASSET_KIND_LABELS: dict[str, str] = {
    "declared": "Pipeline stage (declared graph)",
    "stage": "Pipeline stage (declared graph)",
    "cell": "Content-addressed cell brief",
    "persona": "Per-persona interview",
    "turn": "Per-turn dialogue record",
    "tool_call": "Per-tool-call dispatch",
    "citation": "Per-citation evidence row",
    "claim": "Per-claim sentence in brief",
    "growth_driver": "Growth driver card (planner)",
    "counterfactual": "Counterfactual scenario",
    "decision": "Committed decision",
    "in_year_query": "In-year query (decision diff)",
    "task": "Follow-up task (validate / track)",
}
ASSET_KINDS: tuple[str, ...] = (
    "declared",
    "stage",
    "cell",
    "persona",
    "turn",
    "tool_call",
    "citation",
    "claim",
    "growth_driver",
    "counterfactual",
    "decision",
    "in_year_query",
    "task",
)


@app.get("/assets")
def list_assets(
    limit: int = 50,
    kind: str | None = None,
    question_hash: str | None = None,
    axes_signature: str | None = None,
) -> dict[str, Any]:
    """List materialized assets, newest first.

    The listing covers multiple surfaces:

    * **Declared static assets** (the six pipeline stages) — one row
      per asset key with the latest materialization across all
      partitions / runs. ``kind`` is ``"declared"`` (alias ``"stage"``).
    * **Content-addressed cell briefs** — one row per cell signature
      under ``research_cells``. ``kind`` is ``"cell"``.
    * **Granular evidence assets** — per-persona, per-turn,
      per-tool_call, per-citation, per-claim materializations emitted
      from the interview and synthesis stages. ``kind`` is one of
      ``"persona"``, ``"turn"``, ``"tool_call"``, ``"citation"``,
      ``"claim"``.

    Query parameters:

    * ``kind`` — filter to a single kind (one of ``ASSET_KINDS``).
      ``"stage"`` is treated as an alias for ``"declared"``.
    * ``question_hash`` / ``axes_signature`` — when filtering a granular
      kind, narrow to one cell signature. Ignored for declared/cell
      rows.

    The row shape is friendly for a workbench listing view:
    ``asset_key`` (list of strings), ``asset_key_encoded`` (URL-safe
    handle), ``partition_key``, ``timestamp``, ``kind``, plus the
    metadata bundle Dagster persisted.
    """
    if kind is not None and kind not in ASSET_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"unknown kind={kind!r}; expected one of {sorted(ASSET_KINDS)}",
        )
    kind_filter = "declared" if kind == "stage" else kind
    instance = _resolve_dagster_instance()
    try:
        rows: list[dict[str, Any]] = []

        if kind_filter in (None, "declared"):
            # Declared stage assets — one summary row each. Filter out
            # the content-addressed ``research_cell`` family AND the
            # granular asset prefixes; those land in their own blocks
            # below so we don't double-list them.
            try:
                declared_keys = list(instance.all_asset_keys())
            except Exception:  # noqa: BLE001
                declared_keys = []
            for key in declared_keys:
                if key.path and key.path[0] == _keys.CELL_ASSET_KEY_PREFIX:
                    continue
                if key.path and key.path[0] in GRANULAR_PREFIXES:
                    continue
                try:
                    hist = fetch_asset_history(
                        instance, asset_key_path=list(key.path), limit=1
                    )
                except Exception:  # noqa: BLE001
                    continue
                if not hist:
                    rows.append(
                        {
                            "asset_key": list(key.path),
                            "asset_key_encoded": _keys.encode_asset_key(key.path),
                            "partition_key": None,
                            "timestamp": 0.0,
                            "run_id": "",
                            "metadata": {},
                            "kind": "declared",
                        }
                    )
                    continue
                row = hist[0]
                row["kind"] = "declared"
                rows.append(row)

        if kind_filter in (None, "cell"):
            # Content-addressed research_cell rows (one per signature).
            try:
                cell_rows = list_cell_materializations(instance, limit=limit)
            except Exception:  # noqa: BLE001
                cell_rows = []
            for row in cell_rows:
                row["kind"] = "cell"
                rows.append(row)

        granular_kinds = (
            "persona",
            "turn",
            "tool_call",
            "citation",
            "claim",
            "growth_driver",
            "counterfactual",
            "decision",
            "in_year_query",
            "task",
        )
        for gk in granular_kinds:
            if kind_filter not in (None, gk):
                continue
            try:
                gk_rows = list_granular_assets(
                    instance,
                    kind=gk,
                    limit=limit,
                    question_hash=question_hash,
                    axes_signature=axes_signature,
                )
            except Exception:  # noqa: BLE001
                gk_rows = []
            for row in gk_rows:
                row.setdefault("kind", gk)
                rows.append(row)

        rows.sort(key=lambda r: r.get("timestamp", 0.0), reverse=True)
        return {
            "assets": rows[:limit],
            "kinds": list(ASSET_KINDS),
            "kind_labels": ASSET_KIND_LABELS,
            "kind_filter": kind,
            "partition_sets": {
                "study_cells": "Per-cell stage assets (study-scoped run_id)",
                "research_cells": "Content-addressed cell briefs (cross-study)",
            },
        }
    finally:
        try:
            instance.dispose()
        except Exception:  # noqa: BLE001
            pass


@app.get("/assets/{key_b64}")
def get_asset(key_b64: str) -> dict[str, Any]:
    """Detail view for one asset key: latest materialization + metadata.

    The returned shape is:

    * ``asset_key`` / ``asset_key_encoded`` — addressing handles.
    * ``kind`` — workbench-facing label (``stage``, ``cell``,
      ``persona``, ``turn``, ``tool_call``, ``citation``, ``claim``).
    * ``latest`` — most recent materialization record (or ``None``).
    * ``recent`` — last ``limit`` materializations, newest-first.
    * ``lineage`` — granular upstream/downstream chain when known,
      otherwise the declared-graph fall-back.
    """
    if key_b64 == "graph":
        raise HTTPException(status_code=404, detail="route reserved")
    path = _safe_decode_asset_key(key_b64)
    instance = _resolve_dagster_instance()
    try:
        history = fetch_asset_history(instance, asset_key_path=path, limit=5)
        latest = history[0] if history else None
        kind = kind_for_asset_key(path)
        granular = (
            granular_asset_lineage(path, latest_record=latest)
            if path and path[0] in GRANULAR_PREFIXES
            else None
        )
        lineage = granular or asset_lineage(path)
        return {
            "asset_key": path,
            "asset_key_encoded": key_b64,
            "kind": kind,
            "latest": latest,
            "recent": history,
            "lineage": lineage,
        }
    finally:
        try:
            instance.dispose()
        except Exception:  # noqa: BLE001
            pass


@app.get("/assets/{key_b64}/lineage")
def get_asset_lineage(key_b64: str) -> dict[str, Any]:
    """Upstream + downstream asset keys for one asset.

    Reads from the declared :class:`Definitions` graph for declared
    assets; for the content-addressed ``research_cell`` family returns
    the synthesis stage as upstream. Granular asset keys (persona,
    turn, tool_call, citation, claim) return the recorded
    upstream/downstream chain stored in the latest materialization
    metadata so the FE can render claim → citation → tool_call without
    re-parsing the brief.
    """
    path = _safe_decode_asset_key(key_b64)
    granular: dict[str, list[list[str]]] | None = None
    instance = _resolve_dagster_instance()
    try:
        latest_record: dict[str, Any] | None = None
        if path and path[0] in GRANULAR_PREFIXES:
            try:
                history = fetch_asset_history(
                    instance, asset_key_path=path, limit=1
                )
            except Exception:  # noqa: BLE001
                history = []
            latest_record = history[0] if history else None
            granular = granular_asset_lineage(path, latest_record=latest_record)
    finally:
        try:
            instance.dispose()
        except Exception:  # noqa: BLE001
            pass
    lineage = granular or asset_lineage(path)
    return {
        "asset_key": path,
        "asset_key_encoded": key_b64,
        "kind": kind_for_asset_key(path),
        "upstream": [
            {
                "asset_key": p,
                "asset_key_encoded": _keys.encode_asset_key(p),
                "kind": kind_for_asset_key(p),
            }
            for p in lineage.get("upstream", [])
        ],
        "downstream": [
            {
                "asset_key": p,
                "asset_key_encoded": _keys.encode_asset_key(p),
                "kind": kind_for_asset_key(p),
            }
            for p in lineage.get("downstream", [])
        ],
    }


@app.get("/assets/{key_b64}/history")
def get_asset_history(key_b64: str, limit: int = 25) -> dict[str, Any]:
    """Last N materializations for an asset, newest first."""
    path = _safe_decode_asset_key(key_b64)
    instance = _resolve_dagster_instance()
    try:
        history = fetch_asset_history(
            instance, asset_key_path=path, limit=max(1, min(limit, 200))
        )
        return {
            "asset_key": path,
            "asset_key_encoded": key_b64,
            "kind": kind_for_asset_key(path),
            "history": history,
        }
    finally:
        try:
            instance.dispose()
        except Exception:  # noqa: BLE001
            pass


@app.post("/assets/{key_b64}/materialize")
async def post_asset_materialize(
    key_b64: str, req: AssetMaterializeRequest
) -> dict[str, Any]:
    """Re-materialize an asset.

    Two flavours:

    * For the ``research_cell`` content-addressed key, the caller must
      supply ``question`` + ``axes`` (we don't store the original
      question text in event log metadata at full resolution). We
      kick off a normal ``materialize_research_cell`` in the
      background and return a task handle so the FE can poll
      ``/runs/{run_id}/materializations`` for progress.
    * For declared stage assets (``question_analysis``, ``personas``,
      ...), re-materialization requires a live StageContext, which
      only the orchestrator can construct. We return ``400`` with a
      hint to use the cell-level entry point instead.

    Guardrailed: even when upstream stages are missing, the cell
    materialization path is responsible for orchestrating the full
    pipeline, so we never call ``dagster.materialize`` for a stage
    asset in isolation.
    """
    path = _safe_decode_asset_key(key_b64)
    if not path:
        raise HTTPException(status_code=400, detail="empty asset key")

    head = path[0]
    if head != _keys.CELL_ASSET_KEY_PREFIX:
        raise HTTPException(
            status_code=400,
            detail=(
                "stage assets cannot be re-materialized in isolation; "
                "rerun the parent cell via the research_cell asset "
                "(asset key starts with 'research_cell')."
            ),
        )

    if not req.question:
        raise HTTPException(
            status_code=400,
            detail=(
                "research_cell materialization requires `question` in the "
                "request body. Dagster's event-log metadata only stores "
                "the question hash; pass the full text to re-run."
            ),
        )

    run_id = req.partition_key or new_run_id()
    state = RunState(run_id=run_id, question=req.question, status="running")
    _runs[run_id] = state

    async def _runner() -> None:
        try:
            await materialize_research_cell(
                question=req.question or "",
                run_id=run_id,
                n_personas=req.n_personas,
                max_turns=req.max_turns,
                max_cost_usd=req.max_cost_usd,
                axes=req.axes or None,
            )
            state.status = "complete"
        except Exception as e:  # noqa: BLE001
            logger.exception("re-materialization for asset %s failed", path)
            state.status = "error"
            state.error = str(e)

    task = asyncio.create_task(_runner())
    _asset_materialize_tasks[run_id] = task

    expected_path = _keys.cell_asset_key_path(req.question, req.axes)
    expected_encoded = _keys.encode_asset_key(expected_path)
    return {
        "run_id": run_id,
        "status": "running",
        "asset_key": path,
        "asset_key_encoded": key_b64,
        "expected_asset_key": expected_path,
        "expected_asset_key_encoded": expected_encoded,
        "stream_url": f"/research/{run_id}/stream",
        "materializations_url": f"/runs/{run_id}/materializations",
    }


# ---------------------------------------------------- Single research (legacy)


@app.post("/research")
async def post_research(req: ResearchRequest) -> dict[str, str]:
    settings = get_settings()
    run_id = new_run_id()
    state = RunState(run_id=run_id, question=req.question, status="running")
    _runs[run_id] = state
    create_bus(run_id, settings.runs_dir)

    async def _run() -> None:
        try:
            await run_research(req.question, run_id, req.personas, req.turns)
            state.status = "complete"
        except Exception as e:  # noqa: BLE001
            logger.exception("Run %s failed", run_id)
            state.status = "error"
            state.error = str(e)

    _tasks[run_id] = asyncio.create_task(_run())
    return {"run_id": run_id, "status": state.status}


@app.get("/research/{run_id}/stream")
async def stream(run_id: str) -> EventSourceResponse:
    settings = get_settings()
    bus = get_bus(run_id)
    if bus is None:
        jsonl = settings.runs_dir / run_id / "events.jsonl"
        if not jsonl.exists():
            raise HTTPException(status_code=404, detail="No such run")
        bus = create_bus(run_id, settings.runs_dir)
    return EventSourceResponse(_run_event_generator(run_id, bus))


@app.get("/research/{run_id}/report")
def get_report(run_id: str) -> Response:
    settings = get_settings()
    final = settings.runs_dir / run_id / "final.json"
    if not final.exists():
        raise HTTPException(status_code=404, detail="No report yet")
    return Response(content=final.read_text(), media_type="application/json")


@app.get("/research/{run_id}/state")
def get_state(run_id: str) -> RunState:
    state = _runs.get(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail="No such run")
    return state


# ---------------------------------------------------------------- Per-run API


@app.get("/runs/{run_id}/state")
def get_run_state(run_id: str) -> dict[str, Any]:
    """RunState if we have it in memory; otherwise infer from disk artefacts."""
    state = _runs.get(run_id)
    if state is not None:
        return state.model_dump(mode="json")
    settings = get_settings()
    run_dir = settings.runs_dir / run_id
    if not run_dir.exists():
        raise HTTPException(status_code=404, detail="No such run")
    final_md = run_dir / "final.md"
    events_path = run_dir / "events.jsonl"
    status = (
        "complete"
        if final_md.exists()
        else ("running" if events_path.exists() else "pending")
    )
    return {"run_id": run_id, "status": status, "from_disk": True}


@app.get("/runs/{run_id}/manifest")
def get_run_manifest(run_id: str) -> JSONResponse:
    settings = get_settings()
    run_dir = settings.runs_dir / run_id
    manifest = read_manifest(run_dir)
    if manifest is None:
        raise HTTPException(status_code=404, detail="No manifest yet")
    return JSONResponse(manifest.model_dump(mode="json"))


@app.get("/runs/{run_id}/materializations")
def get_run_materializations(run_id: str) -> dict[str, Any]:
    """Read the per-stage Dagster AssetMaterialization receipts.

    Each cell writes one JSONL line per stage to
    ``runs/<run_id>/dagster_materializations.jsonl`` from inside the
    asset body. The lineage drawer in the workbench DAG view reads this
    to show partition_key, model, spend, hashes, and timestamp without
    needing a long-running Dagster webserver.
    """
    import json as _json

    settings = get_settings()
    run_dir = settings.runs_dir / run_id
    if not run_dir.exists():
        raise HTTPException(status_code=404, detail="No such run")
    path = run_dir / "dagster_materializations.jsonl"
    materializations: list[dict[str, Any]] = []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                materializations.append(_json.loads(line))
            except _json.JSONDecodeError:
                continue
    return {
        "run_id": run_id,
        "partition_set": "study_cells",
        "materializations": materializations,
    }


@app.get("/runs/{run_id}/stages")
def get_run_stages(run_id: str) -> dict[str, Any]:
    settings = get_settings()
    run_dir = settings.runs_dir / run_id
    if not run_dir.exists():
        raise HTTPException(status_code=404, detail="No such run")
    stages = []
    for slug, path in list_stage_files(run_dir):
        stages.append(
            {
                "slug": slug,
                "size_bytes": path.stat().st_size,
                "modified_at": datetime.fromtimestamp(
                    path.stat().st_mtime, tz=timezone.utc
                ).isoformat(),
            }
        )
    return {"run_id": run_id, "stages": stages}


@app.get("/runs/{run_id}/stages/{slug}")
def get_run_stage(run_id: str, slug: str) -> dict[str, Any]:
    settings = get_settings()
    run_dir = settings.runs_dir / run_id
    matches = [(s, p) for s, p in list_stage_files(run_dir) if s == slug or s.startswith(slug)]
    if not matches:
        raise HTTPException(status_code=404, detail=f"No stage matching {slug!r}")
    slug_resolved, path = matches[0]
    return {
        "run_id": run_id,
        "slug": slug_resolved,
        "markdown": path.read_text(encoding="utf-8"),
    }


@app.get("/runs/{run_id}/cost")
def get_run_cost(run_id: str) -> dict[str, Any]:
    """Return the live cost.json for this run if present, plus a few
    derived fields so the workbench can render `$X / $Y budget` directly.
    """
    settings = get_settings()
    run_dir = settings.runs_dir / run_id
    cost_path = run_dir / "cost.json"
    if not cost_path.exists():
        # Fall back to a zero shape so the workbench can render even before
        # the first paid call lands. 404 would force the UI into an error.
        return {
            "run_id": run_id,
            "input_tokens": 0,
            "cached_input_tokens": 0,
            "output_tokens": 0,
            "cost_usd": 0.0,
            "n_calls": 0,
            "by_model": {},
            "by_stage": {},
            "by_persona": {},
            "max_cost_usd": None,
        }
    try:
        import json

        data = json.loads(cost_path.read_text(encoding="utf-8"))
        data["run_id"] = run_id
        return data
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"could not read cost.json: {e}")


@app.get("/runs/{run_id}/tools")
def get_run_tools(run_id: str) -> dict[str, Any]:
    """Return the per-persona tool-call timelines (web_browse, web_fetch,
    duckdb_query) so the workbench can render a tools tab. Reads each
    `<run_dir>/<pid>/tools.json` written at end-of-interview by the
    orchestrator.
    """
    settings = get_settings()
    run_dir = settings.runs_dir / run_id
    if not run_dir.exists():
        raise HTTPException(status_code=404, detail="No such run")
    out: list[dict[str, Any]] = []
    for sub in sorted(run_dir.iterdir()):
        if not sub.is_dir():
            continue
        tools_path = sub / "tools.json"
        if not tools_path.exists():
            continue
        try:
            import json

            payload = json.loads(tools_path.read_text(encoding="utf-8"))
            out.append(payload)
        except Exception:  # noqa: BLE001
            continue
    return {"run_id": run_id, "personas": out}


@app.get("/runs/{run_id}/personas/{persona_id}/transcript")
def get_run_persona_transcript(run_id: str, persona_id: str) -> dict[str, Any]:
    """Per-persona transcript (DialogueTurn list as JSON) for the
    workbench's per-persona drill-down."""
    settings = get_settings()
    path = settings.runs_dir / run_id / persona_id / "transcript.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="No transcript for this persona")
    try:
        import json

        return {
            "run_id": run_id,
            "persona_id": persona_id,
            "turns": json.loads(path.read_text(encoding="utf-8")),
        }
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"transcript parse error: {e}")


@app.get("/runs/{run_id}/personas/{persona_id}/subreport")
def get_run_persona_subreport(run_id: str, persona_id: str) -> dict[str, Any]:
    """Per-persona sub-report markdown (the long-form interview output
    that gets rolled into 04_subreports.md)."""
    settings = get_settings()
    path = settings.runs_dir / run_id / persona_id / "subreport.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail="No subreport for this persona")
    return {
        "run_id": run_id,
        "persona_id": persona_id,
        "markdown": path.read_text(encoding="utf-8"),
    }


@app.get("/runs/{run_id}/final")
def get_run_final(run_id: str) -> dict[str, Any]:
    settings = get_settings()
    run_dir = settings.runs_dir / run_id
    md_path = run_dir / "final.md"
    json_path = run_dir / "final.json"
    if not md_path.exists() and not json_path.exists():
        raise HTTPException(status_code=404, detail="No final brief yet")
    out: dict[str, Any] = {"run_id": run_id}
    if md_path.exists():
        out["markdown"] = md_path.read_text(encoding="utf-8")
    if json_path.exists():
        try:
            import json

            out["json"] = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            pass
    return out


# -------------------------------------------------- Multiverse / Study API


@app.get("/studies/samples")
def list_sample_specs() -> dict[str, Any]:
    """List YAML files in samples/ that look like study specs."""
    if not SAMPLES_DIR.exists():
        return {"samples": []}
    out: list[dict[str, Any]] = []
    for p in sorted(SAMPLES_DIR.glob("study_*.yaml")):
        try:
            raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
            out.append(
                {
                    "name": str(raw.get("name", p.stem)),
                    "filename": p.name,
                    "path": str(p),
                    "question": str(raw.get("question", "")),
                    "n_axes": len(raw.get("axes", []) or []),
                }
            )
        except Exception:  # noqa: BLE001
            continue
    return {"samples": out}


@app.get("/studies")
def get_studies_index() -> dict[str, Any]:
    return {"studies": list_studies()}


@app.post("/studies")
async def post_study(req: StudyRequest) -> dict[str, Any]:
    """Start a new multiverse study. The runner refuses to start without a
    valid prereg block. Each cell creates its own run id under
    `runs/<study_id>_<cell_id>/`."""
    if not req.spec and not req.sample:
        raise HTTPException(
            status_code=400,
            detail="Provide either `spec` (inline) or `sample` (filename in samples/).",
        )

    spec_path: Path | None = None
    spec_obj: StudySpec
    try:
        if req.sample:
            spec_path = SAMPLES_DIR / req.sample
            if not spec_path.exists():
                raise HTTPException(
                    status_code=404, detail=f"sample not found: {req.sample}"
                )
            spec_obj = load_spec(spec_path)
        else:
            spec_obj = StudySpec.model_validate(req.spec)
    except ValidationError as ve:
        raise HTTPException(status_code=400, detail=f"invalid study spec: {ve}")
    except PreregError as pe:
        raise HTTPException(status_code=400, detail=f"invalid prereg: {pe}")

    sid = new_study_id()

    async def _run_study() -> None:
        try:
            await run_study(spec_obj, spec_path=spec_path, study_id=sid)
            try:
                write_spec_curve(sid)
            except Exception:  # noqa: BLE001
                logger.exception("spec curve write failed for study %s", sid)
        except Exception:  # noqa: BLE001
            logger.exception("study %s failed", sid)

    _studies[sid] = asyncio.create_task(_run_study())
    return {"study_id": sid, "status": "running", "n_cells_planned": _planned_cell_count(spec_obj)}


def _planned_cell_count(spec: StudySpec) -> int:
    n = 1
    for ax in spec.axes:
        n *= len(ax.values)
    return n


@app.get("/studies/{study_id}")
def get_study(study_id: str) -> dict[str, Any]:
    study = read_study(study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="No such study")
    return study.model_dump(mode="json")


@app.get("/studies/{study_id}/spec_curve")
def get_spec_curve(study_id: str) -> JSONResponse:
    """Rebuild the spec curve on demand. Cheap (file IO + small string ops)."""
    study = read_study(study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="No such study")
    try:
        curve = build_spec_curve(study_id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"spec curve build failed: {e}")
    return JSONResponse(curve.model_dump(mode="json"))


@app.get("/studies/{study_id}/cost")
def get_study_cost(study_id: str) -> dict[str, Any]:
    """Aggregate cost across all cells of a study. Cheap (8 file reads
    for a 2x2x2 grid) so the workbench polls this on tab change."""
    study = read_study(study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="No such study")
    settings = get_settings()
    rollup = {
        "study_id": study_id,
        "total_cost_usd": 0.0,
        "total_input_tokens": 0,
        "total_cached_input_tokens": 0,
        "total_output_tokens": 0,
        "total_calls": 0,
        "cells": [],
    }
    for cell in study.cells:
        path = settings.runs_dir / cell.run_id / "cost.json"
        if not path.exists():
            rollup["cells"].append(
                {"cell_id": cell.id, "cost_usd": 0.0, "n_calls": 0, "max_cost_usd": None}
            )
            continue
        try:
            import json

            data = json.loads(path.read_text(encoding="utf-8"))
            rollup["cells"].append(
                {
                    "cell_id": cell.id,
                    "cost_usd": data.get("cost_usd", 0.0),
                    "n_calls": int(data.get("n_calls", 0)),
                    "input_tokens": int(data.get("input_tokens", 0)),
                    "cached_input_tokens": int(data.get("cached_input_tokens", 0)),
                    "output_tokens": int(data.get("output_tokens", 0)),
                    "max_cost_usd": data.get("max_cost_usd"),
                }
            )
            rollup["total_cost_usd"] += float(data.get("cost_usd", 0.0))
            rollup["total_input_tokens"] += int(data.get("input_tokens", 0))
            rollup["total_cached_input_tokens"] += int(
                data.get("cached_input_tokens", 0)
            )
            rollup["total_output_tokens"] += int(data.get("output_tokens", 0))
            rollup["total_calls"] += int(data.get("n_calls", 0))
        except Exception:  # noqa: BLE001
            continue
    return rollup


@app.get("/studies/{study_id}/claims")
def get_study_claims(study_id: str) -> dict[str, Any]:
    """List parsed claim assets for every cell of a study.

    Each claim carries the parsed sentence, the cite_ids it references,
    a denormalised summary of each cited evidence row (source label,
    quoted snippet, link or SQL, verifier status), and the addressable
    asset keys for the claim, the upstream citation rows, and the
    tool calls that produced them.

    The endpoint reads claim assets from the Dagster persistent
    instance — the FE never has to re-parse ``final.md``. Cells that
    haven't synthesised yet appear with an empty ``claims`` list and an
    ``unavailable`` reason, never a placeholder.
    """
    study = read_study(study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="No such study")
    instance = _resolve_dagster_instance()
    try:
        cells_out: list[dict[str, Any]] = []
        all_claims: list[dict[str, Any]] = []
        for cell in study.cells:
            cell_question = study.cell_question_template or study.question
            # Recreate the cell-scoped (question_hash, axes_signature) pair
            # so we can narrow the granular asset listing to one cell.
            from ..multiverse import render_cell_question

            full_question = render_cell_question(
                cell_question, cell.addenda or []
            )
            qh = _keys.hash_question(full_question)
            a_sig = _keys.axes_signature(cell.axes or None)
            try:
                rows = fetch_claims_for_cell(
                    instance, question_hash=qh, axes_signature=a_sig
                )
            except Exception:  # noqa: BLE001
                rows = []
            cell_payload: dict[str, Any] = {
                "cell_id": cell.id,
                "run_id": cell.run_id,
                "status": cell.status,
                "axes": cell.axes,
                "question_hash": qh,
                "axes_signature": a_sig,
                "claims": [],
            }
            if not rows:
                cell_payload["unavailable_reason"] = (
                    "cell has not produced any claim assets yet"
                    if cell.status != "complete"
                    else "no claims parsed from final brief"
                )
            for r in rows:
                md = r.get("metadata") or {}
                entry = {
                    "claim_idx": md.get("claim_idx"),
                    "section": md.get("section"),
                    "text": md.get("text"),
                    "cite_ids": md.get("cite_ids") or [],
                    "citations": md.get("citations") or [],
                    "asset_key": r.get("asset_key"),
                    "asset_key_encoded": r.get("asset_key_encoded"),
                    "run_id": r.get("run_id"),
                    "timestamp": r.get("timestamp"),
                    "upstream": md.get("upstream") or [],
                    "downstream": md.get("downstream") or [],
                }
                cell_payload["claims"].append(entry)
                all_claims.append({**entry, "cell_id": cell.id})
            cells_out.append(cell_payload)
        return {
            "study_id": study_id,
            "n_claims": sum(len(c.get("claims") or []) for c in cells_out),
            "cells": cells_out,
            "claims": all_claims,
        }
    finally:
        try:
            instance.dispose()
        except Exception:  # noqa: BLE001
            pass


@app.get("/studies/{study_id}/research")
def get_study_research(study_id: str) -> dict[str, Any]:
    """Stakeholder research view: top occasions at risk + brief excerpt."""
    study = read_study(study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="No such study")
    try:
        summary = build_research_summary(study_id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"research summary failed: {e}")
    return {
        "study_id": summary.study_id,
        "question": summary.question,
        "top_risks": [
            {
                "occasion": c.occasion,
                "line": c.line,
                "robustness": c.robustness,
                "robustness_label": c.robustness_label,
                "illustrative": c.illustrative,
                "source_assets": c.source_assets,
            }
            for c in summary.top_risks
        ],
        "brief_markdown": summary.brief_markdown,
        "brief_illustrative": summary.brief_illustrative,
        "lead_cluster_id": summary.lead_cluster_id,
    }


@app.post("/studies/{study_id}/plan/revise", response_model=PlanReviseResponse)
async def post_study_plan_revise(
    study_id: str, req: PlanReviseRequest
) -> PlanReviseResponse:
    """Preview or apply a natural-language revision to the study spec."""
    study = read_study(study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="No such study")
    try:
        revision = revision_from_instruction(study_id, req.instruction)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    queued_cell_id: str | None = None
    queued_run_id: str | None = None
    applied = False
    if req.apply:
        persist_revision(study_id, revision)
        applied = True
        if req.rerun:
            spec = load_study_spec(study_id)
            queued_cell_id, queued_run_id = pick_proof_cell(study_id, spec)

            async def _proof() -> None:
                try:
                    await rerun_single_cell(study_id, queued_cell_id)
                except Exception:  # noqa: BLE001
                    logger.exception(
                        "plan rerun failed for study %s cell %s",
                        study_id,
                        queued_cell_id,
                    )

            asyncio.create_task(_proof())

    return PlanReviseResponse(
        instruction=revision.instruction,
        diff_lines=revision.diff_lines,
        spec_before=revision.spec_before,
        spec_after=revision.spec_after,
        applied=applied,
        queued_cell_id=queued_cell_id,
        queued_run_id=queued_run_id,
    )


@app.get("/studies/{study_id}/trace", response_model=TraceResponse)
def get_study_trace(
    study_id: str,
    trace_id: str,
    cluster_id: int | None = None,
    run_id: str | None = None,
    metric: str | None = None,
) -> TraceResponse:
    """Evidence chain for a clickable number in the brief or panes."""
    study = read_study(study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="No such study")
    try:
        trace = build_evidence_trace(
            study_id,
            trace_id=trace_id,
            cluster_id=cluster_id,
            run_id=run_id,
            metric=metric,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return TraceResponse(
        trace_id=trace.trace_id,
        label=trace.label,
        value_display=trace.value_display,
        steps=[
            TraceStepModel(
                kind=s.kind,
                title=s.title,
                detail=s.detail,
                asset_ref=s.asset_ref,
                timestamp=s.timestamp,
                code_version=s.code_version,
                prompt_version=s.prompt_version,
            )
            for s in trace.steps
        ],
        run_id=trace.run_id,
        cluster_id=trace.cluster_id,
        illustrative=trace.illustrative,
    )


@app.post("/studies/{study_id}/ask", response_model=AskResponse)
async def post_study_ask(study_id: str, req: AskRequest) -> AskResponse:
    """Plain-language Q&A over a study's own artefacts.

    Loads the final briefs (or executive-answer excerpts of them), the
    cross-scenario spec curve, the evaluated falsifier states, and the
    decision rule; builds a tight curated prompt; calls Sonnet; returns
    a structured ``{answer, citations, unknowns}`` payload.

    The answerer is instructed to translate internal jargon and to never
    quote the decision rule verbatim. See ``diageo_research.ask`` for the
    prompt contract and citation key scheme.
    """
    study = read_study(study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="No such study")
    try:
        result: AskAnswer = await ask_study(
            study_id,
            req.question,
            scenario_id=req.scenario_id,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # noqa: BLE001
        logger.exception("ask: study %s failed", study_id)
        raise HTTPException(status_code=500, detail=f"ask failed: {e}")
    return AskResponse(
        answer=result.answer,
        citations=[
            AskCitation(source=c.source, snippet=c.snippet, link=c.link)
            for c in result.citations
        ],
        unknowns=list(result.unknowns),
    )


@app.get("/studies/{study_id}/prereg")
def get_study_prereg(study_id: str) -> dict[str, Any]:
    study = read_study(study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="No such study")
    path = Path(study.prereg_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="No prereg.yaml on disk")
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return raw


@app.get("/studies/{study_id}/stream")
async def stream_study(study_id: str) -> EventSourceResponse:
    """Multiplexed SSE over all child cells. Each emitted event carries
    `cell_id` so the workbench can route it to the right DAG view."""
    study = read_study(study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="No such study")

    settings = get_settings()
    cell_run_ids = {c.id: c.run_id for c in study.cells}

    async def gen() -> AsyncIterator[dict[str, str]]:
        import json

        # Hydrate clients with current study state up front.
        current = read_study(study_id)
        if current is not None:
            yield {
                "event": "study_state",
                "data": json.dumps(current.model_dump(mode="json"), default=str),
            }

        # Subscribe to every cell bus we can find. Late-bind buses for cells
        # whose runs have not yet emitted anything by reading from disk.
        per_cell: list[tuple[str, asyncio.Queue]] = []
        for cell_id, run_id in cell_run_ids.items():
            bus = get_bus(run_id)
            if bus is None:
                events_path = settings.runs_dir / run_id / "events.jsonl"
                if events_path.exists():
                    bus = create_bus(run_id, settings.runs_dir)
            if bus is None:
                continue
            per_cell.append((cell_id, bus.subscribe(replay=True)))

        if not per_cell:
            # No buses yet — heartbeat once so the client opens its EventSource.
            yield {"event": "heartbeat", "data": ""}
            return

        # Fan all per-cell queues into a single merged queue. One feeder
        # task per cell drains its bus queue, tags events with the cell id,
        # and pushes onto the merged channel. When all feeders close, we
        # emit `close` and return.
        merged: asyncio.Queue[tuple[str, str] | None] = asyncio.Queue()
        live_count = len(per_cell)

        async def _feed(cell_id: str, q: asyncio.Queue) -> None:
            try:
                while True:
                    ev = await q.get()
                    if ev is None:
                        await merged.put((
                            "cell_close",
                            json.dumps({"cell_id": cell_id}),
                        ))
                        return
                    await merged.put((
                        ev.type,
                        _tag_event_with_cell(ev.model_dump_json(), cell_id),
                    ))
            except asyncio.CancelledError:
                return

        feeders = [
            asyncio.create_task(_feed(cell_id, q)) for cell_id, q in per_cell
        ]

        try:
            while live_count > 0:
                try:
                    item = await asyncio.wait_for(merged.get(), timeout=10.0)
                except asyncio.TimeoutError:
                    yield {"event": "heartbeat", "data": ""}
                    continue
                if item is None:
                    break
                event_name, data = item
                yield {"event": event_name, "data": data}
                if event_name == "cell_close":
                    live_count -= 1
            yield {"event": "close", "data": ""}
        finally:
            for f in feeders:
                if not f.done():
                    f.cancel()

    return EventSourceResponse(gen())


# =============================================================== MBP loop
# Decision-loop endpoints: GrowthDriverAsset (study-scoped read), plus
# POST/GET surfaces for Counterfactual / Decision / InYearQuery / Task.
# Implements M2 (asset shapes + endpoints), the backend half of M3 (YAML
# seed for growth drivers), and M5 (in-year diff). See the MBP plan at
# /Users/timleers/.cursor/plans/mbp_loop_fully_working_adc30816.plan.md.
# =============================================================== MBP loop


GROWTH_DRIVERS_SAMPLES_DIR = SAMPLES_DIR / "growth_drivers"
GROWTH_DRIVERS_DEFAULT_SAMPLE = "crown_royal_nfl.yaml"

# Human descriptor for the seeded planning context. The seed file name
# is the index (so a future second MBP gets its own entry) and the
# values surface to the FE in the DecisionAsset payload so /simulation
# and /decision/[id] can show "Crown Royal × NFL 2026-27 MBP · Win
# Football Tailgating · Crown Peach tailgate" rather than the raw
# study question. Keep in sync with the SEEDED_MBP constants in
# web-ui/src/app/page.tsx and web-ui/src/components/global-nav.tsx.
SEEDED_MBP_DESCRIPTORS: dict[str, dict[str, str]] = {
    "crown_royal_nfl.yaml": {
        "mbp_name": "Crown Royal × NFL 2026-27 MBP",
        "brand": "Crown Royal",
        "cycle_window": "Q3 2026 → Q2 2027",
    },
}


class CounterfactualScope(BaseModel):
    """Scope tuple for a counterfactual.

    At least one of ``driver_id`` / ``finding_id`` should be set so the
    counterfactual stays attached to the question that raised it. The
    model permits both being ``None`` because callers occasionally raise
    a scenario directly off a study without a driver — we still need to
    persist it.
    """

    study_id: str = Field(..., min_length=1)
    driver_id: str | None = None
    finding_id: str | None = None


class CounterfactualRequest(BaseModel):
    """Body for ``POST /counterfactuals``."""

    study_id: str = Field(..., min_length=1)
    scope: CounterfactualScope
    prompt: str = Field(..., min_length=1)
    variants: list[Any] = Field(default_factory=list)
    inputs: list[Any] = Field(default_factory=list)
    confidence_per_variant: list[Any] = Field(default_factory=list)
    assumes: list[str] = Field(default_factory=list)
    does_not_assume: list[str] = Field(default_factory=list)


class DecisionScope(BaseModel):
    """Scope tuple for a decision.

    Must carry ``study_id`` plus exactly one of ``driver_id`` /
    ``finding_id`` so the snapshot block knows where to read evidence
    from. The validator allows ``finding_id`` to be ``None`` so a
    decision can be committed directly off a study question.
    """

    study_id: str = Field(..., min_length=1)
    driver_id: str | None = None
    finding_id: str | None = None


class DecisionConfidence(BaseModel):
    """Honest-by-design confidence block.

    Mirrors the FE's confidence sentence + holds_in / of /label tuple so
    the decision asset preserves the exact phrasing that was committed.
    """

    sentence: str = Field(..., min_length=1)
    holds_in: int = Field(..., ge=0)
    of: int = Field(..., ge=0)
    label: str = Field(..., min_length=1)


class DecisionRequest(BaseModel):
    """Body for ``POST /decisions``."""

    scope: DecisionScope
    recommendation: str = Field(..., min_length=1)
    confidence: DecisionConfidence
    fragile_assumption: str = ""
    counterfactual_refs: list[str] = Field(default_factory=list)
    inputs_used: list[str] = Field(default_factory=list)
    owner: str = Field(..., min_length=1)


class TaskScope(BaseModel):
    """Scope tuple for a follow-up task.

    Defaulted to permit a global scope (e.g. a portfolio-level
    validation hook) but the FE's validate-against-promo CTA always
    passes ``study_id`` + one of ``driver_id`` / ``decision_id``.
    """

    study_id: str | None = None
    driver_id: str | None = None
    finding_id: str | None = None
    decision_id: str | None = None


class TaskRequest(BaseModel):
    """Body for ``POST /tasks``."""

    kind: str = Field(..., min_length=1)
    scope: TaskScope = Field(default_factory=TaskScope)
    due_date: str | None = None
    description: str = Field(..., min_length=1)


# ----------------------------------------------------- Growth driver seed


def _load_growth_driver_seed(
    sample_filename: str = GROWTH_DRIVERS_DEFAULT_SAMPLE,
) -> dict[str, Any]:
    """Load the YAML seed at ``samples/growth_drivers/<filename>``.

    Never raises — a missing or malformed file just yields an empty
    payload so the endpoint can still return ``[]`` rather than 5xx.
    """
    path = GROWTH_DRIVERS_SAMPLES_DIR / sample_filename
    if not path.exists():
        logger.warning("growth-driver seed missing: %s", path)
        return {"must_dos": [], "drivers": []}
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:  # noqa: BLE001
        logger.exception("growth-driver seed parse failed: %s", path)
        return {"must_dos": [], "drivers": []}
    must_dos = list(raw.get("must_dos") or [])
    drivers = list(raw.get("drivers") or [])
    return {"must_dos": must_dos, "drivers": drivers}


def _build_growth_driver_asset(
    *,
    study_id: str,
    driver_raw: dict[str, Any],
    must_do_by_id: dict[str, dict[str, Any]],
) -> GrowthDriverAsset:
    """Hydrate one driver row from YAML into a :class:`GrowthDriverAsset`.

    ``must_do_by_id`` is the slug-keyed map of the seed's must_dos so
    the driver carries the parent Must-Do's title / summary / split for
    the FE without a second fetch.
    """
    must_do_id = str(driver_raw.get("must_do") or "")
    must_do = must_do_by_id.get(must_do_id) or {}
    return GrowthDriverAsset(
        driver_id=str(driver_raw["driver_id"]),
        study_id=study_id,
        must_do=must_do_id,
        driver_name=str(driver_raw.get("driver_name") or ""),
        one_line=str(driver_raw.get("one_line") or ""),
        hypotheses=list(driver_raw.get("hypotheses") or []),
        fragile_assumption=str(driver_raw.get("fragile_assumption") or ""),
        evidence_pointers=list(driver_raw.get("evidence_pointers") or []),
        markets=list(driver_raw.get("markets") or []),
        confidence_pill=str(driver_raw.get("confidence_pill") or ""),
        confidence_value=(
            int(driver_raw["confidence_value"])
            if driver_raw.get("confidence_value") is not None
            else None
        ),
        illustrative=bool(driver_raw.get("illustrative", True)),
        activities=list(driver_raw.get("activities") or []),
        must_do_title=must_do.get("title"),
        must_do_summary=must_do.get("summary"),
        must_do_ap_split=(
            int(must_do["ap_split"]) if must_do.get("ap_split") is not None else None
        ),
        must_do_confidence=(
            int(must_do["confidence"])
            if must_do.get("confidence") is not None
            else None
        ),
        must_do_focus_markets=list(must_do.get("focus_markets") or []),
        validate_next=list(driver_raw.get("validate_next") or []),
        simulation_prompt=str(driver_raw.get("simulation_prompt") or ""),
    )


@app.get("/studies/{study_id}/growth-drivers")
def get_study_growth_drivers(study_id: str) -> dict[str, Any]:
    """Return the GrowthDriverAssets seeded for this study.

    Seeded from ``samples/growth_drivers/crown_royal_nfl.yaml`` (M3).
    Per-driver overrides at ``runs/growth_drivers/<driver_id>.json``
    merge on top so an edited driver stays edited across restarts.
    Every entry carries ``illustrative`` so the FE can render an
    explicit chip; only ``crown-peach-tailgate`` ships with
    ``illustrative=false`` and points at real BLS/TTB pointers.

    Materializing on read keeps Dagit + ``/assets`` in sync with the
    backing YAML without requiring a manual migration step. The emit is
    best-effort: a failed Dagster write still returns the drivers so
    the FE never goes blank.
    """
    seed = _load_growth_driver_seed()
    must_dos = list(seed.get("must_dos") or [])
    must_do_by_id = {str(m.get("id")): m for m in must_dos if m.get("id")}

    instance = _resolve_dagster_instance()
    try:
        drivers_out: list[dict[str, Any]] = []
        for raw in seed.get("drivers") or []:
            try:
                asset = _build_growth_driver_asset(
                    study_id=study_id,
                    driver_raw=raw,
                    must_do_by_id=must_do_by_id,
                )
            except KeyError as e:
                logger.warning(
                    "skipping malformed growth driver entry (missing %s): %r",
                    e,
                    raw,
                )
                continue
            override = load_decision_asset(
                GROWTH_DRIVER_ASSET_PREFIX, asset.driver_id
            )
            if override:
                merged = {**asset.to_dict(), **override}
                merged["study_id"] = study_id
                asset = GrowthDriverAsset.from_dict(merged)
            try:
                emit_growth_driver_materialization(instance, asset=asset)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "emit_growth_driver_materialization failed for %s",
                    asset.driver_id,
                )
            drivers_out.append(asset.to_dict())
    finally:
        try:
            instance.dispose()
        except Exception:  # noqa: BLE001
            pass

    return {
        "study_id": study_id,
        "must_dos": must_dos,
        "drivers": drivers_out,
        "seed": GROWTH_DRIVERS_DEFAULT_SAMPLE,
    }


# ----------------------------------------------------- Counterfactual POST


@app.post("/counterfactuals")
def post_counterfactual(req: CounterfactualRequest) -> dict[str, Any]:
    """Persist + materialize one CounterfactualAsset.

    Idempotent on content: same inputs → same ``cf_id`` (and same
    asset_key), so a double-POST collapses onto one asset. Useful for
    the FE's stress-test flow where a user can land on /simulation
    twice with the same params.
    """
    scope_dict = req.scope.model_dump(exclude_none=False)
    cf_id = content_id_counterfactual(
        study_id=req.study_id,
        scope=scope_dict,
        prompt=req.prompt,
        variants=req.variants,
        inputs=req.inputs,
        confidence_per_variant=req.confidence_per_variant,
        assumes=req.assumes,
        does_not_assume=req.does_not_assume,
    )
    asset = CounterfactualAsset(
        cf_id=cf_id,
        scope=scope_dict,
        prompt=req.prompt,
        variants=req.variants,
        inputs=req.inputs,
        confidence_per_variant=req.confidence_per_variant,
        assumes=req.assumes,
        does_not_assume=req.does_not_assume,
        study_id=req.study_id,
        created_at=_now_utc_iso(),
    )
    instance = _resolve_dagster_instance()
    try:
        payload = emit_counterfactual_materialization(instance, asset=asset)
    finally:
        try:
            instance.dispose()
        except Exception:  # noqa: BLE001
            pass
    return {
        "cf_id": cf_id,
        "asset_key": payload["asset_key_path"],
        "asset_key_encoded": payload["asset_key_encoded"],
        "scope": scope_dict,
        "created_at": payload["created_at"],
    }


# ----------------------------------------------------- Decision POST


def _build_mbp_descriptor(
    *,
    driver_id: str,
    sample_filename: str = GROWTH_DRIVERS_DEFAULT_SAMPLE,
) -> dict[str, str] | None:
    """Resolve a planner-readable MBP descriptor for a driver-scoped decision.

    Looks up the driver and its parent Must-Do in the YAML seed, then
    pairs them with the SEEDED_MBP_DESCRIPTORS entry for the same seed
    file. Returns ``None`` when the driver doesn't appear in any seed
    (research-finding decisions, or unknown driver ids), which lets the
    FE fall back to the study/finding scope copy.
    """
    if not driver_id:
        return None
    seed = _load_growth_driver_seed(sample_filename)
    drivers = list(seed.get("drivers") or [])
    must_dos = list(seed.get("must_dos") or [])
    must_do_by_id = {str(m.get("id")): m for m in must_dos if m.get("id")}
    driver_raw = next(
        (d for d in drivers if str(d.get("driver_id")) == str(driver_id)),
        None,
    )
    if driver_raw is None:
        return None
    must_do_id = str(driver_raw.get("must_do") or "")
    must_do = must_do_by_id.get(must_do_id) or {}
    base = SEEDED_MBP_DESCRIPTORS.get(sample_filename, {})
    return {
        "mbp_name": str(base.get("mbp_name") or ""),
        "brand": str(base.get("brand") or ""),
        "cycle_window": str(base.get("cycle_window") or ""),
        "must_do_id": must_do_id,
        "must_do": str(must_do.get("title") or ""),
        "driver_id": str(driver_raw.get("driver_id") or driver_id),
        "driver": str(driver_raw.get("driver_name") or ""),
    }


def _collect_decision_evidence_pointers(
    *, study_id: str, scope: dict[str, Any], inputs_used: list[str]
) -> list[str]:
    """Best-effort evidence-pointer set for a decision scope.

    When the scope names a ``driver_id`` we pull the driver's
    ``evidence_pointers`` from the YAML seed (overlaid with any
    persisted override). ``inputs_used`` is always folded in so a
    caller-supplied pointer survives even when the driver lookup
    yields nothing.
    """
    pointers: list[str] = list(inputs_used or [])
    driver_id = scope.get("driver_id")
    if driver_id:
        # Prefer the persisted override (the FE may have stamped a new
        # pointer onto the driver).
        override = load_decision_asset(GROWTH_DRIVER_ASSET_PREFIX, str(driver_id))
        if override and override.get("evidence_pointers"):
            pointers.extend(override.get("evidence_pointers") or [])
        else:
            seed = _load_growth_driver_seed()
            must_do_by_id = {
                str(m.get("id")): m for m in (seed.get("must_dos") or []) if m.get("id")
            }
            for raw in seed.get("drivers") or []:
                if str(raw.get("driver_id")) != str(driver_id):
                    continue
                try:
                    asset = _build_growth_driver_asset(
                        study_id=study_id,
                        driver_raw=raw,
                        must_do_by_id=must_do_by_id,
                    )
                except KeyError:
                    continue
                pointers.extend(asset.evidence_pointers or [])
    # Dedup while preserving order then sort for canonical form.
    seen: set[str] = set()
    out: list[str] = []
    for p in pointers:
        s = str(p)
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return sorted(out)


def _collect_decision_claim_ids(study_id: str) -> list[str]:
    """Collect stable claim identifiers for every cell of a study.

    Uses the existing :func:`fetch_claims_for_cell` reader so the
    snapshot block is consistent with what ``/studies/{id}/claims``
    surfaces to the FE. Returns the encoded asset keys of every
    claim — encoded form is stable across processes and serialisation.
    """
    study = read_study(study_id)
    if study is None:
        return []
    from ..multiverse import render_cell_question

    instance = _resolve_dagster_instance()
    try:
        out: list[str] = []
        for cell in study.cells:
            template = study.cell_question_template or study.question
            full_question = render_cell_question(template, cell.addenda or [])
            qh = _keys.hash_question(full_question)
            a_sig = _keys.axes_signature(cell.axes or None)
            try:
                rows = fetch_claims_for_cell(
                    instance, question_hash=qh, axes_signature=a_sig
                )
            except Exception:  # noqa: BLE001
                rows = []
            for r in rows:
                handle = r.get("asset_key_encoded") or ""
                if handle:
                    out.append(handle)
        return out
    finally:
        try:
            instance.dispose()
        except Exception:  # noqa: BLE001
            pass


def _read_spec_curve_bytes(study_id: str) -> bytes:
    """Return the bytes of ``runs/<study_id>/spec_curve.json`` (or b"")."""
    settings = get_settings()
    path = settings.runs_dir / study_id / "spec_curve.json"
    if not path.exists():
        return b""
    try:
        return path.read_bytes()
    except OSError:
        return b""


def _now_utc_iso() -> str:
    """Tiny convenience so api.py never depends on the granular_assets
    private ``_now_iso`` helper directly. Round-trips through ISO 8601
    with a UTC offset."""
    return datetime.now(tz=timezone.utc).isoformat()


@app.post("/decisions")
def post_decision(req: DecisionRequest) -> dict[str, Any]:
    """Commit one DecisionAsset and stamp its snapshot block.

    Snapshot hashing follows M5: evidence_hash + claims_hash + curve_hash
    are all sha256 over canonicalised sorted inputs (see
    :func:`compute_decision_snapshot`). Same hashing scheme as the rest
    of :mod:`diageo_research.keys` — no new hash algorithm invented.

    Returns ``{decision_id, asset_key, asset_key_encoded, committed_at,
    snapshot}`` so the FE can redirect to ``/decision/<id>`` and render
    the snapshot block immediately.
    """
    scope_dict = req.scope.model_dump(exclude_none=False)
    if not scope_dict.get("study_id"):
        raise HTTPException(
            status_code=400, detail="decision scope requires study_id"
        )
    committed_at = _now_utc_iso()
    evidence_pointers = _collect_decision_evidence_pointers(
        study_id=scope_dict["study_id"],
        scope=scope_dict,
        inputs_used=req.inputs_used,
    )
    claim_ids = _collect_decision_claim_ids(scope_dict["study_id"])
    curve_bytes = _read_spec_curve_bytes(scope_dict["study_id"])
    snapshot = compute_decision_snapshot(
        study_id=scope_dict["study_id"],
        evidence_pointers=evidence_pointers,
        claim_ids=claim_ids,
        curve_bytes=curve_bytes,
    )

    decision_id = content_id_decision(
        scope=scope_dict,
        recommendation=req.recommendation,
        fragile_assumption=req.fragile_assumption,
        counterfactual_refs=req.counterfactual_refs,
        inputs_used=req.inputs_used,
        owner=req.owner,
        committed_at=committed_at,
    )
    mbp_descriptor = _build_mbp_descriptor(
        driver_id=str(scope_dict.get("driver_id") or ""),
    )
    asset = DecisionAsset(
        decision_id=decision_id,
        scope=scope_dict,
        recommendation=req.recommendation,
        confidence=req.confidence.model_dump(),
        fragile_assumption=req.fragile_assumption,
        counterfactual_refs=list(req.counterfactual_refs or []),
        inputs_used=list(req.inputs_used or []),
        owner=req.owner,
        committed_at=committed_at,
        snapshot=snapshot,
        mbp=mbp_descriptor,
    )
    instance = _resolve_dagster_instance()
    try:
        payload = emit_decision_materialization(instance, asset=asset)
    finally:
        try:
            instance.dispose()
        except Exception:  # noqa: BLE001
            pass

    return {
        "decision_id": decision_id,
        "asset_key": payload["asset_key_path"],
        "asset_key_encoded": payload["asset_key_encoded"],
        "scope": scope_dict,
        "committed_at": committed_at,
        "snapshot": snapshot,
        "mbp": mbp_descriptor,
    }


# ----------------------------------------------------- In-year query GET


@app.get("/decisions/{decision_id}")
def get_decision(decision_id: str) -> dict[str, Any]:
    """Read one persisted decision back by id.

    Helper for the FE's /decision/[id] page. The persistence file is
    the source of truth — the Dagster event log just mirrors it.

    Hydrates ``mbp`` on read for legacy decisions persisted before the
    descriptor was introduced, so the FE can render the MBP-scope
    provenance line without a one-off backfill.
    """
    payload = load_decision_asset(DECISION_ASSET_PREFIX, decision_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="no such decision")
    if not payload.get("mbp"):
        scope = payload.get("scope") or {}
        driver_id = scope.get("driver_id") if isinstance(scope, dict) else None
        if driver_id:
            payload["mbp"] = _build_mbp_descriptor(driver_id=str(driver_id))
    return payload


@app.get("/decisions/{decision_id}/in-year")
def get_decision_in_year(decision_id: str) -> dict[str, Any]:
    """Re-compute current snapshot and diff against the decision's snapshot.

    Persists an :class:`InYearQueryAsset` on every call (so callers can
    answer 'when did we ask?' from the audit trail later) and returns
    ``{decision_id, asked_at, diff, current_hashes, snapshot_hashes,
    query_id, asset_key, asset_key_encoded}``.

    The diff covers evidence_added / evidence_changed /
    evidence_invalidated. See
    :func:`diageo_research.granular_assets.compute_decision_in_year_diff`
    for the semantic — change detection is intentionally coarse today
    and only fires when claims_hash or curve_hash has shifted (a more
    granular per-pointer change detector is a future refinement).
    """
    decision_payload = load_decision_asset(DECISION_ASSET_PREFIX, decision_id)
    if decision_payload is None:
        raise HTTPException(status_code=404, detail="no such decision")

    snapshot = decision_payload.get("snapshot") or {}
    scope = decision_payload.get("scope") or {}
    study_id = scope.get("study_id") or ""
    if not study_id:
        raise HTTPException(
            status_code=500,
            detail=f"decision {decision_id} is missing study_id in its scope",
        )

    current_evidence = _collect_decision_evidence_pointers(
        study_id=study_id,
        scope=scope,
        inputs_used=list(decision_payload.get("inputs_used") or []),
    )
    current_claims = _collect_decision_claim_ids(study_id)
    current_curve = _read_spec_curve_bytes(study_id)
    current = compute_decision_snapshot(
        study_id=study_id,
        evidence_pointers=current_evidence,
        claim_ids=current_claims,
        curve_bytes=current_curve,
    )
    diff = compute_decision_in_year_diff(snapshot=snapshot, current=current)

    asked_at = _now_utc_iso()
    query_id = content_id_in_year_query(
        decision_id=decision_id,
        asked_at=asked_at,
        question="what changed since commit?",
    )
    snapshot_hashes = {
        "evidence_hash": snapshot.get("evidence_hash"),
        "claims_hash": snapshot.get("claims_hash"),
        "curve_hash": snapshot.get("curve_hash"),
    }
    current_hashes = {
        "evidence_hash": current.get("evidence_hash"),
        "claims_hash": current.get("claims_hash"),
        "curve_hash": current.get("curve_hash"),
    }

    query_asset = InYearQueryAsset(
        query_id=query_id,
        bound_to=decision_id,
        asked_at=asked_at,
        question="what changed since commit?",
        diff=diff,
        answer=(
            "no changes detected since commit"
            if (
                not diff["evidence_added"]
                and not diff["evidence_changed"]
                and not diff["evidence_invalidated"]
                and snapshot_hashes == current_hashes
            )
            else "evidence delta detected — see diff"
        ),
    )
    instance = _resolve_dagster_instance()
    try:
        payload = emit_in_year_query_materialization(instance, asset=query_asset)
    finally:
        try:
            instance.dispose()
        except Exception:  # noqa: BLE001
            pass

    return {
        "decision_id": decision_id,
        "query_id": query_id,
        "asset_key": payload["asset_key_path"],
        "asset_key_encoded": payload["asset_key_encoded"],
        "asked_at": asked_at,
        "diff": diff,
        "snapshot_hashes": snapshot_hashes,
        "current_hashes": current_hashes,
        "answer": payload["answer"],
    }


# ----------------------------------------------------- Tasks POST


@app.post("/tasks")
def post_task(req: TaskRequest) -> dict[str, Any]:
    """Persist + materialize one TaskAsset.

    Used by the FE's 'Validate against promo data' CTA on /simulation,
    plus any other follow-up validation hook the loop spawns. Status
    starts at ``open``; the workbench will let users move it through
    ``in_progress`` and ``done`` (out of scope for the M2 deliverable).
    """
    scope_dict = req.scope.model_dump(exclude_none=False)
    created_at = _now_utc_iso()
    task_id = content_id_task(
        kind=req.kind,
        scope=scope_dict,
        description=req.description,
        due_date=req.due_date,
        created_at=created_at,
    )
    task = TaskAsset(
        task_id=task_id,
        kind=req.kind,
        scope=scope_dict,
        description=req.description,
        created_at=created_at,
        due_date=req.due_date,
        status="open",
    )
    instance = _resolve_dagster_instance()
    try:
        payload = emit_task_materialization(instance, asset=task)
    finally:
        try:
            instance.dispose()
        except Exception:  # noqa: BLE001
            pass
    return {
        "task_id": task_id,
        "asset_key": payload["asset_key_path"],
        "asset_key_encoded": payload["asset_key_encoded"],
        "kind": req.kind,
        "scope": scope_dict,
        "due_date": req.due_date,
        "created_at": created_at,
        "status": "open",
    }


# ----------------------------------------------------------- Internal helpers


async def _run_event_generator(run_id: str, bus: EventBus) -> AsyncIterator[dict[str, str]]:
    """Replay-then-tail SSE for a single run id (legacy /research stream)."""
    queue = bus.subscribe(replay=True)
    while True:
        try:
            event = await asyncio.wait_for(queue.get(), timeout=10.0)
        except asyncio.TimeoutError:
            yield {"event": "heartbeat", "data": ""}
            continue
        if event is None:
            yield {"event": "close", "data": ""}
            break
        yield {"event": event.type, "data": event.model_dump_json()}


def _tag_event_with_cell(payload_json: str, cell_id: str) -> str:
    """Inject `cell_id` into the payload JSON without re-parsing."""
    import json

    try:
        obj = json.loads(payload_json)
    except Exception:  # noqa: BLE001
        return payload_json
    obj["cell_id"] = cell_id
    return json.dumps(obj, default=str)

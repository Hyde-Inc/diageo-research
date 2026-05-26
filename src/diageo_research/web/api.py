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


@app.get("/assets")
def list_assets(limit: int = 50) -> dict[str, Any]:
    """List materialized assets, newest first.

    The listing covers two surfaces:

    * **Declared static assets** (the six pipeline stages) — one row
      per asset key with the latest materialization across all
      partitions / runs.
    * **Content-addressed cell briefs** — one row per cell signature
      under ``research_cells``.

    The shape is friendly for a workbench listing view: ``asset_key``
    (list of strings), ``asset_key_encoded`` (URL-safe handle),
    ``partition_key``, ``timestamp``, plus the metadata bundle Dagster
    persisted.
    """
    instance = _resolve_dagster_instance()
    try:
        rows: list[dict[str, Any]] = []

        # Declared stage assets — one summary row each. Filter out the
        # content-addressed ``research_cell`` family; those land in the
        # ``cell`` block below so we don't double-list them.
        try:
            declared_keys = list(instance.all_asset_keys())
        except Exception:  # noqa: BLE001
            declared_keys = []
        for key in declared_keys:
            if key.path and key.path[0] == _keys.CELL_ASSET_KEY_PREFIX:
                continue
            try:
                hist = fetch_asset_history(instance, asset_key_path=list(key.path), limit=1)
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

        # Content-addressed research_cell rows (one per signature).
        try:
            cell_rows = list_cell_materializations(instance, limit=limit)
        except Exception:  # noqa: BLE001
            cell_rows = []
        for row in cell_rows:
            row["kind"] = "cell"
            rows.append(row)

        rows.sort(key=lambda r: r.get("timestamp", 0.0), reverse=True)
        return {
            "assets": rows[:limit],
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
    """Detail view for one asset key: latest materialization + metadata."""
    if key_b64 == "graph":
        raise HTTPException(status_code=404, detail="route reserved")
    path = _safe_decode_asset_key(key_b64)
    instance = _resolve_dagster_instance()
    try:
        history = fetch_asset_history(instance, asset_key_path=path, limit=5)
        latest = history[0] if history else None
        return {
            "asset_key": path,
            "asset_key_encoded": key_b64,
            "latest": latest,
            "recent": history,
            "lineage": asset_lineage(path),
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
    assets; for the content-addressed ``research_cell`` family, returns
    the synthesis stage as upstream (the brief's immediate producer).
    """
    path = _safe_decode_asset_key(key_b64)
    lineage = asset_lineage(path)
    return {
        "asset_key": path,
        "asset_key_encoded": key_b64,
        "upstream": [
            {"asset_key": p, "asset_key_encoded": _keys.encode_asset_key(p)}
            for p in lineage["upstream"]
        ],
        "downstream": [
            {"asset_key": p, "asset_key_encoded": _keys.encode_asset_key(p)}
            for p in lineage["downstream"]
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

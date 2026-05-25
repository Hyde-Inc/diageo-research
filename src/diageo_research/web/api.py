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

from ..config import get_settings
from ..dagster_assets import asset_graph_json
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
from ..orchestrator import new_run_id, run_research
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

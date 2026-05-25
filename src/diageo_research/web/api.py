"""FastAPI app — POST /research → SSE event stream → final report.

When a request opts into `human_in_loop`, the orchestrator pauses after the
seed outline + analyst panel + section assignments and emits a
`plan_ready_for_review` SSE event. The UI then:

- `GET  /research/{run_id}/plan`  — read the current plan
- `POST /research/{run_id}/plan`  — submit edits and resume / abort

Edits replace the executive_intent / personas / sections fields in place;
the orchestrator rebuilds section assignments from any kept overrides and
fills missing coverage automatically.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from .. import hitl
from ..config import get_settings
from ..events import create_bus, get_bus
from ..followup import answer_followup
from ..models import PlanEdit, PlanForReview, RunState
from ..orchestrator import new_run_id, run_research

logger = logging.getLogger(__name__)

app = FastAPI(title="Diageo Research")

# CORS — the bundled static UI shares the origin, but the adc-nextjs-fe
# integration lives on a different host (Vercel), so allow any origin in
# dev. Tighten via `CORS_ALLOW_ORIGINS` env var in production.
import os

_cors_origins = os.environ.get("CORS_ALLOW_ORIGINS", "*").split(",")
_cors_origins = [o.strip() for o in _cors_origins if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_runs: dict[str, RunState] = {}
_tasks: dict[str, asyncio.Task[Any]] = {}


class ResearchRequest(BaseModel):
    question: str = Field(..., min_length=1)
    personas: int | None = Field(default=None, ge=1, le=8)
    turns: int | None = Field(default=None, ge=1, le=12)
    human_in_loop: bool = Field(
        default=False,
        description=(
            "If true, the run pauses after the seed plan is generated so a "
            "human can edit personas + outline before any interviews start."
        ),
    )


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/research")
async def post_research(req: ResearchRequest) -> dict[str, str]:
    settings = get_settings()
    run_id = new_run_id()
    state = RunState(run_id=run_id, question=req.question, status="running")
    _runs[run_id] = state
    create_bus(run_id, settings.runs_dir)  # pre-create so the SSE can attach immediately

    async def _run() -> None:
        try:
            await run_research(
                req.question,
                run_id,
                req.personas,
                req.turns,
                human_in_loop=req.human_in_loop,
            )
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

    queue = bus.subscribe(replay=True)

    async def event_generator() -> AsyncIterator[dict[str, str]]:
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

    return EventSourceResponse(event_generator())


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


@app.get("/research/{run_id}/plan")
def get_plan(run_id: str) -> PlanForReview:
    """Return the current plan if the run is paused at HITL review."""
    plan = hitl.get_plan(run_id)
    if plan is None:
        raise HTTPException(
            status_code=404,
            detail="No plan awaiting review for this run.",
        )
    return plan


@app.post("/research/{run_id}/plan")
def submit_plan(run_id: str, edit: PlanEdit) -> dict[str, str]:
    """Accept human edits + resume the orchestrator. Returns 404 when the run
    isn't currently paused at HITL review."""
    if not hitl.is_paused(run_id):
        raise HTTPException(
            status_code=404,
            detail="Run is not awaiting plan review.",
        )
    accepted = hitl.submit_edit(run_id, edit)
    if not accepted:
        # Race: a previous submit just resolved the pause.
        raise HTTPException(
            status_code=409,
            detail="Plan review already resolved.",
        )
    return {"run_id": run_id, "decision": edit.decision}


class FollowupRequest(BaseModel):
    question: str = Field(..., min_length=1)


@app.post("/research/{run_id}/followup")
async def post_followup(run_id: str, req: FollowupRequest) -> EventSourceResponse:
    """Stream a context-only follow-up answer about a completed run.

    Loads `final.json` + per-persona sub-reports off disk and streams a
    single Anthropic call back as SSE chunks (`token` deltas, terminal
    `done` with cited `[S?]` IDs, or `error`). No tools, no panel re-run,
    no `runs/` writes.

    404 when the run hasn't synthesized a final brief yet — the agent has
    nothing to cite.
    """
    settings = get_settings()
    final = settings.runs_dir / run_id / "final.json"
    if not final.exists():
        raise HTTPException(
            status_code=404,
            detail="Run has no final report yet — wait for synthesis to complete.",
        )

    async def event_generator() -> AsyncIterator[dict[str, str]]:
        async for chunk in answer_followup(run_id, req.question, settings):
            yield {
                "event": chunk.type,
                "data": chunk.model_dump_json(),
            }

    return EventSourceResponse(event_generator())

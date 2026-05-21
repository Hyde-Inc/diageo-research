"""FastAPI app — POST /research → SSE event stream → final report."""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from ..config import get_settings
from ..events import create_bus, get_bus
from ..models import RunState
from ..orchestrator import new_run_id, run_research

logger = logging.getLogger(__name__)

app = FastAPI(title="Diageo Research")

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_runs: dict[str, RunState] = {}
_tasks: dict[str, asyncio.Task[Any]] = {}


class ResearchRequest(BaseModel):
    question: str = Field(..., min_length=1)
    personas: int | None = Field(default=None, ge=1, le=8)
    turns: int | None = Field(default=None, ge=1, le=12)


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

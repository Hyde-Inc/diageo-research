"""Per-run async event bus with jsonl persistence.

Each `EventBus` writes every emitted event to `runs/<run_id>/events.jsonl` and
fans out to any number of `asyncio.Queue` subscribers (CLI tree view, SSE
endpoint). New subscribers replay all already-emitted events from the jsonl
file so reconnecting SSE clients pick up mid-run.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from .models import SSEEvent


class EventBus:
    def __init__(self, run_id: str, jsonl_path: Path) -> None:
        self.run_id = run_id
        self.jsonl_path = jsonl_path
        self.jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        # touch
        self.jsonl_path.touch(exist_ok=True)
        self._subscribers: list[asyncio.Queue[SSEEvent | None]] = []
        self._closed = False

    def subscribe(self, replay: bool = True) -> asyncio.Queue[SSEEvent | None]:
        q: asyncio.Queue[SSEEvent | None] = asyncio.Queue()
        self._subscribers.append(q)
        if replay and self.jsonl_path.exists():
            for line in self.jsonl_path.read_text().splitlines():
                if not line.strip():
                    continue
                try:
                    q.put_nowait(SSEEvent.model_validate_json(line))
                except Exception:
                    continue
            if self._closed:
                q.put_nowait(None)
        return q

    async def emit(self, event: SSEEvent) -> None:
        with self.jsonl_path.open("a") as f:
            f.write(event.model_dump_json() + "\n")
        for q in list(self._subscribers):
            await q.put(event)

    async def close(self) -> None:
        self._closed = True
        for q in list(self._subscribers):
            await q.put(None)

    @property
    def closed(self) -> bool:
        return self._closed


_buses: dict[str, EventBus] = {}


def create_bus(run_id: str, runs_dir: Path) -> EventBus:
    if run_id in _buses:
        return _buses[run_id]
    bus = EventBus(run_id, runs_dir / run_id / "events.jsonl")
    _buses[run_id] = bus
    return bus


def get_bus(run_id: str) -> EventBus | None:
    return _buses.get(run_id)


def drop_bus(run_id: str) -> None:
    _buses.pop(run_id, None)

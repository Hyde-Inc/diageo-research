"""The perspective agent must dispatch multiple tool_use blocks in parallel
within a single assistant turn (improvement #5)."""
import asyncio
from typing import Any
from unittest.mock import AsyncMock

import pytest

from diageo_research.models import Persona
from diageo_research.perspective import PerspectiveAgent


@pytest.mark.asyncio
async def test_parallel_dispatch_runs_concurrently(monkeypatch):
    """Three tools in one assistant turn should run in parallel, so total
    elapsed time should be approximately one sleep, not the sum of three."""
    persona = Persona(
        id="p1",
        name="P1",
        role="r",
        lens="l",
        description="d",
        system_prompt="s",
        persona_type="expert",
    )
    agent = PerspectiveAgent(client=AsyncMock(), persona=persona, question="q", dataset_schema="schema")

    sleep_s = 0.4

    async def slow_dispatch(name: str, args: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(sleep_s)
        return {"name": name, "args": args}

    agent.registry.dispatch = slow_dispatch  # type: ignore[assignment]

    pending = [
        ("id1", "duckdb_query", {"sql": "SELECT 1"}),
        ("id2", "duckdb_query", {"sql": "SELECT 2"}),
        ("id3", "web_browse", {"query": "x"}),
    ]
    loop = asyncio.get_event_loop()
    start = loop.time()
    raws, out = await agent._dispatch_parallel(pending, on_event=None)
    elapsed = loop.time() - start

    assert len(out) == 3
    assert len(raws) == 3
    # If the dispatch were sequential it'd take ~3*sleep_s. Parallel should be
    # ~1*sleep_s. Give a generous ceiling to avoid flakes on slow CI.
    assert elapsed < sleep_s * 2.0
    # tool_result blocks come back in the same order as pending.
    assert [r["tool_use_id"] for r in out] == ["id1", "id2", "id3"]
    # Raws are the dispatcher dicts, also ordered.
    assert [r["name"] for r in raws] == ["duckdb_query", "duckdb_query", "web_browse"]

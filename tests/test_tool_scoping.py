"""Tools must be scoped by persona_type (consumer = fetch only; expert = all),
and web_browse must be capped per turn so we don't burn 30+ min on a single
turn (improvement: bound the per-turn browse budget)."""
import pytest

from diageo_research.tools.registry import ToolRegistry


def test_consumer_specs_only_include_web_fetch():
    reg = ToolRegistry(persona_type="consumer")
    names = {s["name"] for s in reg.specs}
    assert names == {"web_fetch"}


def test_expert_specs_include_all_three():
    reg = ToolRegistry(persona_type="expert")
    names = {s["name"] for s in reg.specs}
    assert names == {"web_browse", "web_fetch", "duckdb_query"}


@pytest.mark.asyncio
async def test_consumer_cannot_call_web_browse():
    reg = ToolRegistry(persona_type="consumer")
    out = await reg.dispatch("web_browse", {"query": "x"})
    assert "error" in out
    assert "consumer" in out["error"]


@pytest.mark.asyncio
async def test_consumer_cannot_call_duckdb_query():
    reg = ToolRegistry(persona_type="consumer")
    out = await reg.dispatch("duckdb_query", {"sql": "SELECT 1"})
    assert "error" in out
    assert "consumer" in out["error"]


@pytest.mark.asyncio
async def test_expert_web_browse_cap_returns_hint_after_first_call(monkeypatch):
    """After 1 web_browse the dispatcher must return a hint (not actually call
    `browse`) so the model switches to web_fetch."""
    from diageo_research.tools import registry as registry_mod

    calls: list[tuple[str, int]] = []

    async def fake_browse(q, max_pages):
        calls.append((q, max_pages))
        return [{"url": "https://x.com", "title": "x", "text": "ok"}]

    monkeypatch.setattr(registry_mod, "browse", fake_browse)

    reg = ToolRegistry(persona_type="expert")
    first = await reg.dispatch("web_browse", {"query": "q1"})
    second = await reg.dispatch("web_browse", {"query": "q2"})

    # First call went through, second was short-circuited
    assert len(calls) == 1
    assert first["snippets"]  # 1 snippet returned
    assert second["snippets"] == []
    assert "hint" in second
    assert "web_fetch" in second["hint"].lower()


@pytest.mark.asyncio
async def test_start_turn_resets_browse_cap(monkeypatch):
    """A new turn must reset the per-turn web_browse counter."""
    from diageo_research.tools import registry as registry_mod

    n_calls = 0

    async def fake_browse(q, max_pages):
        nonlocal n_calls
        n_calls += 1
        return [{"url": "u", "title": "t", "text": ""}]

    monkeypatch.setattr(registry_mod, "browse", fake_browse)

    reg = ToolRegistry(persona_type="expert")
    await reg.dispatch("web_browse", {"query": "turn1-q1"})
    # second call in same turn → blocked
    out = await reg.dispatch("web_browse", {"query": "turn1-q2"})
    assert out["snippets"] == []
    # new turn → budget restored
    reg.start_turn()
    await reg.dispatch("web_browse", {"query": "turn2-q1"})
    assert n_calls == 2


@pytest.mark.asyncio
async def test_duckdb_dispatch_for_consumer_blocked(monkeypatch, tmp_path):
    """Even a syntactically valid SQL is rejected for a consumer persona."""
    from diageo_research.config import get_settings

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setenv("DUCKDB_PATH", str(tmp_path / "main.duckdb"))
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("RUNS_DIR", str(tmp_path / "runs"))
    get_settings.cache_clear()

    reg = ToolRegistry(persona_type="consumer")
    out = await reg.dispatch("duckdb_query", {"sql": "SELECT 42"})
    assert "error" in out
    get_settings.cache_clear()

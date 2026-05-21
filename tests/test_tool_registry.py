import pytest

from diageo_research.tools.registry import TOOL_SPECS, ToolRegistry


def test_tool_specs_shape():
    names = {s["name"] for s in TOOL_SPECS}
    assert names == {"web_browse", "web_fetch", "duckdb_query"}
    for s in TOOL_SPECS:
        assert "description" in s
        assert s["input_schema"]["type"] == "object"


@pytest.mark.asyncio
async def test_dispatch_unknown_tool_returns_error():
    reg = ToolRegistry()
    out = await reg.dispatch("nope", {})
    assert "error" in out


@pytest.mark.asyncio
async def test_duckdb_dispatch_rejects_non_select(monkeypatch, tmp_path):
    # Point DuckDB at a temp DB and run a forbidden statement; expect error result.
    from diageo_research.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setenv("DUCKDB_PATH", str(tmp_path / "main.duckdb"))
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("RUNS_DIR", str(tmp_path / "runs"))

    reg = ToolRegistry()
    out = await reg.dispatch("duckdb_query", {"sql": "DROP TABLE foo"})
    assert out.get("error")
    assert "SELECT" in out["error"] or "WITH" in out["error"]
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_duckdb_dispatch_select_assigns_cite_id(monkeypatch, tmp_path):
    from diageo_research.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setenv("DUCKDB_PATH", str(tmp_path / "main.duckdb"))
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("RUNS_DIR", str(tmp_path / "runs"))

    reg = ToolRegistry()
    out = await reg.dispatch("duckdb_query", {"sql": "SELECT 42 AS answer"})
    assert out["cite_id"] == "Q1"
    assert out["columns"] == ["answer"]
    assert out["rows"] == [{"answer": 42}]
    get_settings.cache_clear()

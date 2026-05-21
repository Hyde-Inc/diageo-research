"""Tests for _wrap_tool_result, especially the dispatcher-hint surfacing path
(P0 bug: cap-exceeded `web_browse` hint was being silently dropped)."""
from diageo_research.perspective import _wrap_tool_result


def test_wrap_surfaces_dispatcher_hint_when_present():
    """When ToolRegistry returns a `hint` (e.g., cap-exceeded), it MUST reach
    the model — otherwise the model retries the same dead end."""
    result = {
        "snippets": [],
        "query": "x",
        "hint": "`web_browse` budget for this turn is exhausted (cap=1). Use `web_fetch`.",
    }
    out = _wrap_tool_result("web_browse", result)
    assert "budget for this turn is exhausted" in out
    assert "web_fetch" in out


def test_wrap_falls_back_to_default_hint_when_no_dispatcher_hint():
    result = {"snippets": [], "query": "x"}
    out = _wrap_tool_result("web_browse", result)
    assert "browser-use returned empty" in out


def test_wrap_includes_snippets_with_cite_ids():
    result = {
        "snippets": [
            {"cite_id": "B5", "url": "https://x.com", "title": "X", "text": "body"},
        ],
        "query": "q",
    }
    out = _wrap_tool_result("web_browse", result)
    assert "cite_id=B5" in out
    assert "Title: X" in out
    assert "Text: body" in out


def test_wrap_handles_web_fetch_same_way():
    result = {"snippets": [], "query": "https://example.com", "hint": "url 404'd"}
    out = _wrap_tool_result("web_fetch", result)
    assert "url 404'd" in out
    assert "Fetched URL" in out


def test_wrap_duckdb_result_serialized_as_json():
    result = {"cite_id": "Q1", "columns": ["x"], "rows": [{"x": 1}]}
    out = _wrap_tool_result("duckdb_query", result)
    assert '"cite_id": "Q1"' in out
    assert '"x": 1' in out

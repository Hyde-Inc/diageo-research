"""Tests for the lightweight web_fetch tool (improvement #5)."""
import httpx
import pytest

from diageo_research.tools import web_fetch


@pytest.mark.asyncio
async def test_web_fetch_extracts_title_and_body(monkeypatch):
    html = (
        "<html><head><title>Diageo plc</title></head><body>"
        "<header>nav</header>"
        "<main><p>Diageo plc is a British multinational alcoholic beverage company. "
        "It owns Johnnie Walker, Smirnoff, Don Julio.</p></main>"
        "<script>tracking()</script>"
        "<style>.x{}</style>"
        "</body></html>"
    )

    class _StubResp:
        status_code = 200
        headers = {"content-type": "text/html"}
        text = html
        url = "https://example.com/diageo"

    class _StubClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            return _StubResp()

    monkeypatch.setattr(web_fetch.httpx, "AsyncClient", _StubClient)
    out = await web_fetch.fetch("https://example.com/diageo", query="Diageo Johnnie")
    assert len(out) == 1
    assert out[0]["url"] == "https://example.com/diageo"
    assert out[0]["title"] == "Diageo plc"
    assert "Diageo plc is a British" in out[0]["text"]
    assert "tracking" not in out[0]["text"]  # script stripped


@pytest.mark.asyncio
async def test_web_fetch_rejects_non_http():
    out = await web_fetch.fetch("ftp://example.com/file")
    assert out == []


@pytest.mark.asyncio
async def test_web_fetch_serializes_json_payloads(monkeypatch):
    """BLS API and many .gov endpoints return JSON. We now serialize them as
    text so the model can extract numbers without a separate parsing tool."""

    class _StubResp:
        status_code = 200
        headers = {"content-type": "application/json"}
        url = "https://api.bls.gov/x"

        @staticmethod
        def json():
            return {"series": [{"data": [{"year": 2024, "value": 290.8}]}]}

    class _StubClient:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url): return _StubResp()

    monkeypatch.setattr(web_fetch.httpx, "AsyncClient", _StubClient)
    out = await web_fetch.fetch("https://api.bls.gov/x")
    assert len(out) == 1
    assert "290.8" in out[0]["text"]
    assert "2024" in out[0]["text"]


@pytest.mark.asyncio
async def test_web_fetch_handles_http_error(monkeypatch):
    class _BoomClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            raise httpx.ConnectError("kaboom")

    monkeypatch.setattr(web_fetch.httpx, "AsyncClient", _BoomClient)
    out = await web_fetch.fetch("https://example.com")
    assert out == []

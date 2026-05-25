"""Lightweight `web_fetch(url)` tool (improvement #5).

When the persona already knows the URL (Wikipedia page, specific FRED series,
TTB statistical release URL, a Shanken article), running a 60–180 s
`browser-use` session is wasted budget. `web_fetch` is just `httpx.get` +
readability/HTML-to-text extraction; one HTTP round-trip, typically <1 s.

Returns the same `{url, title, text}` shape as `browser.browse` so the
`ToolRegistry` dispatcher can assign a `B?` cite_id and store it as a
`BrowserSnippet` upstream.
"""
from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT_S = 20
_MAX_TEXT_CHARS = 1200
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36 diageo-research/0.1"
)


async def fetch(
    url: str,
    query: str | None = None,
    *,
    failed_urls: dict[str, str] | None = None,
) -> list[dict[str, str]]:
    """Fetch one URL and return a one-element snippet list. Returns [] on
    failure so the caller sees an empty tool_result and can fall back.

    When ``failed_urls`` is provided (a mutable dict, typically owned by
    ``ToolRegistry``), each failure path writes a short reason into it
    keyed by ``(host, path)`` so the registry can short-circuit a
    verbatim retry of the same URL on a later iteration without issuing
    another network call. This is the primary defence against the
    Sonnet loop where the model keeps re-fetching a dead URL until the
    iteration budget is gone.
    """
    if not _is_valid_http_url(url):
        logger.warning("web_fetch: rejecting non-HTTP url=%r", url)
        _record_failure(failed_urls, url, "invalid_url")
        return []

    headers = {
        "User-Agent": _USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        async with httpx.AsyncClient(
            timeout=_DEFAULT_TIMEOUT_S,
            follow_redirects=True,
            headers=headers,
        ) as client:
            resp = await client.get(url)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout) as e:
        logger.warning("web_fetch: network error url=%r err=%s", url, e)
        _record_failure(failed_urls, url, f"network_error: {type(e).__name__}")
        return []
    except Exception as e:  # noqa: BLE001
        # SSLError lives at httpx.SSLError (a re-export). Catching it
        # alongside the catch-all gives the same cache treatment but
        # surfaces a friendlier reason string for the model.
        reason = "ssl_error" if "SSL" in type(e).__name__.upper() else f"error: {type(e).__name__}"
        logger.warning("web_fetch: error url=%r err=%s", url, e)
        _record_failure(failed_urls, url, reason)
        return []

    if resp.status_code >= 400:
        logger.warning("web_fetch: status=%d url=%r", resp.status_code, url)
        _record_failure(failed_urls, url, f"http_{resp.status_code}")
        return []

    content_type = resp.headers.get("content-type", "").lower()
    if "json" in content_type:
        # BLS API + many .gov endpoints return JSON; serialize and return as text
        # so the model can extract numbers without a separate parsing tool.
        try:
            payload = resp.json()
            body_text = _summarize_json(payload, query)
            title = url
            if body_text:
                logger.info("web_fetch: ok (json) url=%r chars=%d", url, len(body_text))
                return [{"url": str(resp.url), "title": title[:200], "text": body_text[:_MAX_TEXT_CHARS]}]
        except Exception as e:  # noqa: BLE001
            logger.warning("web_fetch: failed to parse JSON url=%r err=%s", url, e)
            _record_failure(failed_urls, url, f"json_parse_error: {type(e).__name__}")
            return []
        _record_failure(failed_urls, url, "empty_body")
        return []

    if "html" not in content_type and "text" not in content_type and "xml" not in content_type:
        logger.warning("web_fetch: skipping non-text content-type=%r url=%r", content_type, url)
        _record_failure(failed_urls, url, f"unsupported_content_type: {content_type[:60]}")
        return []

    html = resp.text
    title = _extract_title(html) or url
    body_text = _extract_body_text(html, query)
    if not body_text:
        logger.warning("web_fetch: no extractable text url=%r", url)
        _record_failure(failed_urls, url, "empty_body")
        return []
    logger.info("web_fetch: ok url=%r status=%d chars=%d", url, resp.status_code, len(body_text))
    return [
        {
            "url": str(resp.url),
            "title": title[:200],
            "text": body_text[:_MAX_TEXT_CHARS],
        }
    ]


def _record_failure(
    failed_urls: dict[str, str] | None, url: str, reason: str
) -> None:
    """Write a failure reason into the caller's per-cell cache, keyed by
    a naive ``(host, path)`` normalization. No-op when no cache is
    provided (lets ``fetch()`` keep its existing standalone behaviour
    for direct test use)."""
    if failed_urls is None:
        return
    parsed = urlparse((url or "").strip())
    netloc = (parsed.netloc or "").lower()
    path = parsed.path or "/"
    failed_urls[f"{netloc}{path}"] = reason


def _is_valid_http_url(url: str) -> bool:
    if not isinstance(url, str) or not url.strip():
        return False
    parsed = urlparse(url.strip())
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style|noscript|svg|head|footer|nav|aside)[^>]*>.*?</\1>",
    re.IGNORECASE | re.DOTALL,
)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _extract_title(html: str) -> str | None:
    m = _TITLE_RE.search(html)
    if not m:
        return None
    return _strip_entities(_WS_RE.sub(" ", m.group(1).strip()))


def _extract_body_text(html: str, query: str | None) -> str:
    cleaned = _SCRIPT_STYLE_RE.sub(" ", html)
    cleaned = _TAG_RE.sub(" ", cleaned)
    cleaned = _strip_entities(cleaned)
    cleaned = _WS_RE.sub(" ", cleaned).strip()
    if not cleaned:
        return ""
    if query:
        focused = _focus_around_query(cleaned, query)
        if focused:
            return focused
    return cleaned[:_MAX_TEXT_CHARS]


def _focus_around_query(text: str, query: str) -> str:
    """If any query word appears in the text, return a window centered on the
    earliest match. Else return prefix."""
    query_words = [w for w in re.split(r"\W+", query.lower()) if len(w) > 3]
    if not query_words:
        return text[:_MAX_TEXT_CHARS]
    lower = text.lower()
    earliest = None
    for w in query_words:
        idx = lower.find(w)
        if idx >= 0 and (earliest is None or idx < earliest):
            earliest = idx
    if earliest is None:
        return text[:_MAX_TEXT_CHARS]
    half = _MAX_TEXT_CHARS // 2
    start = max(0, earliest - half)
    end = min(len(text), start + _MAX_TEXT_CHARS)
    return text[start:end]


def _summarize_json(payload: object, query: str | None) -> str:
    """Render a JSON payload as a compact text summary suitable for an LLM
    tool_result. We don't pretty-print huge blobs — we cap at 4 KB and trust
    the model to extract numbers."""
    import json as _json
    try:
        text = _json.dumps(payload, indent=2, default=str)
    except Exception:  # noqa: BLE001
        return ""
    if len(text) <= _MAX_TEXT_CHARS:
        return text
    if query:
        return _focus_around_query(text, query)
    return text[:_MAX_TEXT_CHARS]


_ENTITY_MAP = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&#39;": "'",
    "&nbsp;": " ",
}


def _strip_entities(s: str) -> str:
    for k, v in _ENTITY_MAP.items():
        s = s.replace(k, v)
    return re.sub(r"&#\d+;", " ", s)


__all__ = ["fetch"]


# Anthropic tool spec — exported here so registry.py can compose it.
TOOL_SPEC: dict[str, Any] = {
    "name": "web_fetch",
    "description": (
        "Fetch a SINGLE known URL and return its title + extracted text. Use this when "
        "you already know exactly which page to read (Wikipedia article, specific FRED "
        "series page, TTB statistical release URL, an article you saw in earlier search). "
        "Faster and cheaper than `web_browse`. The returned snippet gets a stable `cite_id` "
        "like `B7`; you MUST inline `[B7]` in every sentence of your final answer that "
        "draws on it."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "Full http(s) URL to fetch.",
            },
            "focus_query": {
                "type": "string",
                "description": (
                    "Optional: a short query/keyword string. If provided, the extracted "
                    "text is centered on the earliest occurrence of these words."
                ),
            },
        },
        "required": ["url"],
    },
}

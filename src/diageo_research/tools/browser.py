"""Browser tool — thin wrapper around `browser-use` for the perspective agent.

The perspective LLM calls `web_browse({query, max_pages})`. We spawn a
short-lived browser-use Agent whose task is to search the open web for the
query and return a JSON array of {url, title, text} entries. Each entry
becomes a `BrowserSnippet` upstream in the dispatcher (which assigns the
`B?` cite_id).

Browser-use needs Chromium installed:
    pip install playwright && playwright install chromium

Diagnostics
-----------
This module logs verbosely under the ``diageo_research.tools.browser`` logger
so we can tell *why* a call returned zero snippets. Every fall-through path
(import error, LLM adapter missing, agent crash, JSON parse failure, empty
final_result) is logged at WARNING with a short ``reason=`` tag, and every
successful run logs the agent step count, visited URLs, and a truncated
preview of ``history.final_result()`` at INFO.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import re
from typing import Any

from ..config import get_settings

logger = logging.getLogger(__name__)

_FINAL_RESULT_PREVIEW_CHARS = 600
_CLOUD_BACKOFFS_S = (10, 25, 60)  # 429 retry waits — cloud sessions are slow to free
_browse_semaphore: asyncio.Semaphore | None = None
_browse_semaphore_lock = asyncio.Lock()


async def _get_browse_semaphore() -> asyncio.Semaphore:
    """Process-wide gate on concurrent browser-use sessions. Initialised once
    from settings so we never breach Browser Use Cloud's per-plan concurrent
    session cap (3 on the free tier; HTTP 429 otherwise)."""
    global _browse_semaphore
    if _browse_semaphore is not None:
        return _browse_semaphore
    async with _browse_semaphore_lock:
        if _browse_semaphore is None:
            settings = get_settings()
            limit = max(1, settings.browser_use_max_concurrency)
            _browse_semaphore = asyncio.Semaphore(limit)
            logger.info("browse: concurrency semaphore initialised limit=%d", limit)
    return _browse_semaphore


def _is_429(err: Exception) -> bool:
    msg = str(err).lower()
    return (
        "429" in msg
        or "concurrent session" in msg
        or "rate limit" in msg
        or "too many requests" in msg
    )


async def browse(query: str, max_pages: int = 3) -> list[dict[str, str]]:
    """Return up to ``max_pages`` raw snippets (``{url, title, text}``). Cite
    IDs are assigned by the caller in ``tools.registry``. Returns ``[]`` on
    failure so the perspective sees an empty tool_result and can fall back.

    Logs the reason for every empty return so we can diagnose silent no-ops.
    """
    settings = get_settings()
    logger.info("browse: start query=%r max_pages=%d", query, max_pages)

    try:
        from browser_use import Agent, Browser  # type: ignore[import-not-found]
    except ImportError as e:
        logger.warning("browse: reason=import_error browser-use missing or incompatible: %s", e)
        return []

    llm = _build_llm(settings.sonnet_model_id, settings.anthropic_api_key)
    if llm is None:
        logger.warning("browse: reason=no_llm_adapter no ChatAnthropic adapter available")
        return []

    semaphore = await _get_browse_semaphore()
    if semaphore.locked() or semaphore._value == 0:  # type: ignore[attr-defined]
        logger.info("browse: queued behind concurrency semaphore query=%r", query)

    task = (
        f"You are a research assistant. Find up to {max_pages} authoritative web pages "
        f"that answer this query: {query!r}.\n\n"
        "Strategy:\n"
        "  1. PREFER direct navigation to a known authoritative domain when the query "
        "implies one (TTB.gov, BLS.gov, BEA.gov, Census.gov, FRED via stlouisfed.org, "
        "CDC.gov, NIAAA, StatCan, INEGI, Wikipedia, Shanken News Daily, Drinks International, "
        "Punch, VinePair, SevenFifty Daily, Just Drinks).\n"
        "  2. Search engines (google.com, bing.com, duckduckgo.com) are FINE to use; "
        "they may serve a CAPTCHA in headless mode but the stealth browser handles it. "
        "Use search when you do not already know the canonical URL.\n"
        "  3. If a direct URL guess 404s, fall back to a search rather than guessing again.\n"
        "  4. For each page you open, capture: the exact URL, a short title, and a "
        "<=600 character excerpt of the passage most relevant to the query.\n"
        "  5. Stop as soon as you have the snippets — do not exceed 8 navigation steps.\n\n"
        "Output: return ONLY a JSON array (no prose, no markdown fence) shaped like:\n"
        '[{"url": "...", "title": "...", "text": "..."}, ...]\n'
        "Call `done` with that JSON string as the final result."
    )

    session: Any = None
    history: Any = None
    timeout_s = settings.browser_use_timeout_s

    async with semaphore:
        for attempt, backoff in enumerate((0,) + _CLOUD_BACKOFFS_S):
            if backoff:
                logger.warning(
                    "browse: cloud 429 — backing off %ds before retry (attempt %d/%d) query=%r",
                    backoff, attempt, len(_CLOUD_BACKOFFS_S), query,
                )
                await asyncio.sleep(backoff)
            try:
                session = _build_session(Browser, settings)
                agent = Agent(task=task, llm=llm, browser=session)
                history = await asyncio.wait_for(agent.run(), timeout=timeout_s)
                break
            except asyncio.TimeoutError:
                logger.warning("browse: reason=timeout query=%r after %ds", query, timeout_s)
                await _shutdown_session(session)
                return []
            except Exception as e:  # noqa: BLE001
                msg = str(e).lower()
                if _is_429(e) and attempt < len(_CLOUD_BACKOFFS_S):
                    await _shutdown_session(session)
                    session = None
                    continue  # retry after backoff
                if "executable doesn't exist" in msg or "playwright install" in msg or "chromium" in msg:
                    logger.warning(
                        "browse: reason=chromium_missing browser driver not installed; "
                        "run `uvx browser-use install` (or `python -m playwright install chromium`). err=%s",
                        e,
                    )
                elif _is_429(e):
                    logger.warning(
                        "browse: reason=cloud_quota_exhausted exhausted retries on HTTP 429 — "
                        "raise browser_use_max_concurrency or upgrade plan. err=%s", e,
                    )
                else:
                    logger.warning(
                        "browse: reason=agent_error query=%r err=%s", query, e, exc_info=True,
                    )
                await _shutdown_session(session)
                return []
            finally:
                # On success / non-429 failure we shut down outside the loop;
                # on 429 retry we already shut down before `continue`.
                pass
        await _shutdown_session(session)

    final_text = _extract_final_output(history)
    _log_history_diagnostics(history, final_text, query)

    snippets = _parse_snippets(final_text, max_pages)
    if snippets:
        logger.info("browse: parsed %d snippet(s) from JSON for query=%r", len(snippets), query)
        return snippets

    fallback = _fallback_snippets_from_history(history, max_pages)
    if fallback:
        logger.warning(
            "browse: reason=json_parse_failed fell back to history.urls/extracted_content "
            "and synthesized %d snippet(s) for query=%r",
            len(fallback),
            query,
        )
        return fallback

    logger.warning(
        "browse: reason=empty_result no JSON, no urls, no extracted_content for query=%r",
        query,
    )
    return []


def _build_session(browser_cls: Any, settings: Any) -> Any:
    """Construct a `Browser` (aka `BrowserSession`). If `BROWSER_USE_API_KEY` is
    set (or `browser_use_cloud=True`), promote to Browser Use Cloud's stealth
    browser — README-blessed one-liner for proxy rotation + CAPTCHA solving.
    Falls back to a local headless Chromium otherwise."""
    api_key = settings.browser_use_api_key or os.environ.get("BROWSER_USE_API_KEY")
    use_cloud = settings.browser_use_cloud
    if use_cloud is None:
        use_cloud = bool(api_key)
    if use_cloud:
        if api_key and not os.environ.get("BROWSER_USE_API_KEY"):
            os.environ["BROWSER_USE_API_KEY"] = api_key
        logger.info("browse: using Browser Use Cloud (stealth)")
        try:
            return browser_cls(use_cloud=True)
        except TypeError:
            logger.warning("browse: installed browser-use lacks use_cloud kwarg; falling back to local")
    logger.info("browse: using local Chromium headless=%s", settings.browser_use_headless)
    return browser_cls(headless=settings.browser_use_headless)


def _build_llm(model_id: str, api_key: str) -> Any | None:
    try:
        from browser_use.llm import ChatAnthropic  # type: ignore[import-not-found]

        logger.debug("browse: using browser_use.llm.ChatAnthropic adapter")
        return ChatAnthropic(model=model_id, api_key=api_key)
    except ImportError:
        pass
    try:
        from langchain_anthropic import ChatAnthropic as LCChatAnthropic  # type: ignore[import-not-found]

        logger.debug("browse: using langchain_anthropic.ChatAnthropic adapter (fallback)")
        return LCChatAnthropic(model_name=model_id, api_key=api_key)
    except ImportError:
        logger.warning("browse: no supported ChatAnthropic adapter found for browser-use")
        return None


def _extract_final_output(history: Any) -> str:
    if history is None:
        return ""
    try:
        out = history.final_result()  # type: ignore[attr-defined]
        if isinstance(out, str):
            return out
        if out is not None:
            return json.dumps(out) if not isinstance(out, (bytes, bytearray)) else out.decode("utf-8", "ignore")
    except Exception as e:  # noqa: BLE001
        logger.debug("browse: history.final_result() raised: %s", e)
    return ""


def _log_history_diagnostics(history: Any, final_text: str, query: str) -> None:
    """Emit one INFO line with the levers we care about when triaging silent
    no-ops: did the agent take any steps, what URLs did it visit, did it error,
    and what did the final_result blob look like."""
    if history is None:
        logger.info("browse: history=None query=%r", query)
        return
    steps = _safe_call(history, "number_of_steps", default=None)
    urls = _safe_call(history, "urls", default=None)
    has_errors = _safe_call(history, "has_errors", default=None)
    is_done = _safe_call(history, "is_done", default=None)
    preview = (final_text or "")[:_FINAL_RESULT_PREVIEW_CHARS].replace("\n", " ")
    logger.info(
        "browse: query=%r steps=%s is_done=%s has_errors=%s urls=%s final_result[:%d]=%r",
        query,
        steps,
        is_done,
        has_errors,
        urls if not isinstance(urls, list) else urls[:6],
        _FINAL_RESULT_PREVIEW_CHARS,
        preview,
    )


def _safe_call(obj: Any, attr: str, default: Any = None) -> Any:
    try:
        value = getattr(obj, attr)
        return value() if callable(value) else value
    except Exception:  # noqa: BLE001
        return default


def _parse_snippets(text: str, max_pages: int) -> list[dict[str, str]]:
    if not text:
        return []
    match = re.search(r"\[.*\]", text, re.DOTALL)
    payload = match.group(0) if match else text
    try:
        data = json.loads(payload)
    except Exception as e:  # noqa: BLE001
        logger.debug("browse: JSON parse failed: %s; payload head=%r", e, payload[:200])
        return []
    if not isinstance(data, list):
        logger.debug("browse: JSON parsed but not a list (type=%s)", type(data).__name__)
        return []
    out: list[dict[str, str]] = []
    for row in data[:max_pages]:
        if not isinstance(row, dict):
            continue
        url = str(row.get("url", "")).strip()
        if not url:
            continue
        out.append(
            {
                "url": url,
                "title": str(row.get("title") or url),
                "text": str(row.get("text", ""))[:1200],
            }
        )
    return out


def _fallback_snippets_from_history(history: Any, max_pages: int) -> list[dict[str, str]]:
    """If the agent did real work but failed to format JSON, salvage snippets
    from the structured history: visited URLs paired with the longest
    extracted text chunks."""
    if history is None:
        return []
    urls = _safe_call(history, "urls", default=[]) or []
    extracted = _safe_call(history, "extracted_content", default=[]) or []
    if not isinstance(urls, list) or not urls:
        return []
    texts = [str(t) for t in extracted if isinstance(t, (str, bytes))] if isinstance(extracted, list) else []
    snippets: list[dict[str, str]] = []
    seen: set[str] = set()
    for i, raw_url in enumerate(urls):
        url = str(raw_url).strip()
        if not url or url in seen:
            continue
        seen.add(url)
        text = texts[i] if i < len(texts) else (texts[0] if texts else "")
        snippets.append({"url": url, "title": url, "text": text[:1200]})
        if len(snippets) >= max_pages:
            break
    return snippets


async def _shutdown_session(session: Any) -> None:
    if session is None:
        return
    for method_name in ("stop", "close", "kill"):
        method = getattr(session, method_name, None)
        if method is None:
            continue
        try:
            result = method()
            if inspect.isawaitable(result):
                await result
            return
        except Exception:  # noqa: BLE001
            continue

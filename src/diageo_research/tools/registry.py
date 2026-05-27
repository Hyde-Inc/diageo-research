"""Anthropic tool specs + per-perspective dispatcher.

Each `PerspectiveAgent` owns one `ToolRegistry`; the registry assigns monotonic
`B?` (browser) and `Q?` (DuckDB) cite_ids across the persona's whole
conversation so the model can refer back to earlier citations and `citations.py`
can stitch sub-reports together.

Tools are **scoped by `persona_type`**:

- ``consumer`` personas get ``web_fetch`` only. They speak from lived
  experience — no open-web searches, no SQL. They can fetch a brand page,
  a Total Wine product page, or a TikTok hashtag URL if the interviewer asks.
- ``expert`` personas get the full kit (``web_browse``, ``web_fetch``,
  ``duckdb_query``). They do the heavy data grounding for the brief.

Per-turn caps: ``max_web_browse_per_turn`` (default 1) prevents a single
turn from burning 30+ minutes on browse loops.

``tool_call_log`` is the runtime audit trail this dispatcher keeps. Each
log entry carries enough state for the granular ``tool_call`` asset
materializations to reconstruct what happened (tool name, args, outcome,
cite_id, result summary, started/finished/latency timestamps). The
granular asset emit functions read this log in
:mod:`diageo_research.granular_assets`; the workbench reads the same log
when rendering the per-persona tools tab.
"""
from __future__ import annotations

import datetime as _dt
import time
from typing import Any
from urllib.parse import urlparse

from ..config import get_settings
from ..models import BrowserSnippet, Citation, PersonaType, QueryResult
from .browser import browse
from .duckdb_tool import run_query
from .web_fetch import TOOL_SPEC as WEB_FETCH_SPEC
from .web_fetch import fetch as web_fetch


def _utcnow_iso() -> str:
    return _dt.datetime.now(tz=_dt.timezone.utc).isoformat()


def _fetch_failure_key(url: str) -> str:
    """Normalize a URL to ``(host, path)`` for the per-cell failure cache.

    Naive: lower-cases the netloc and keeps the path as-is. Punycode/IDN
    edge cases are NOT handled — same logical host spelled differently
    will dedupe imperfectly. For our use case (an LLM that retries an
    identical string verbatim) that's fine.
    """
    parsed = urlparse((url or "").strip())
    netloc = (parsed.netloc or "").lower()
    path = parsed.path or "/"
    return f"{netloc}{path}"

TOOL_SPECS: list[dict[str, Any]] = [
    {
        "name": "web_browse",
        "description": (
            "Search the open web and return up to `max_pages` page snippets. Use this ONLY "
            "when you do not already know which URL to read. For qualitative or "
            "current-events grounding: news, analyst commentary, regulatory filings, "
            "festival/cultural context. Each returned snippet has a stable `cite_id` like "
            "`B3`; you MUST inline `[B3]` in every sentence of your final answer that "
            "draws on that snippet. If you already know the URL, prefer `web_fetch` — "
            "it is much faster."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural-language query, e.g. 'TTB 2025 spirits import rule change'.",
                },
                "max_pages": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 6,
                    "default": 3,
                },
            },
            "required": ["query"],
        },
    },
    WEB_FETCH_SPEC,
    {
        "name": "duckdb_query",
        "description": (
            "Run a read-only SQL SELECT against the local public-dataset DuckDB (BLS CPI, US "
            "Census retail (NAICS 4453), TTB, FRED, NHTSA FARS, NIAAA, etc.). Schemas plus "
            "named analytics macros (`yoy_pct`, `cumulative_pct`, `real_growth`, "
            "`elasticity_estimate`) are listed in your system prompt. Each result is "
            "assigned a stable `cite_id` like `Q2`; you MUST inline `[Q2]` in every sentence "
            "of your answer that cites this result. Only `SELECT` / `WITH ... SELECT` "
            "statements allowed; row limit 200."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": "A single SELECT or WITH ... SELECT statement against the local DuckDB.",
                }
            },
            "required": ["sql"],
        },
    },
]


_TOOLS_BY_PERSONA_TYPE: dict[PersonaType, set[str]] = {
    "consumer": {"web_fetch"},
    "expert": {"web_browse", "web_fetch", "duckdb_query"},
}


class ToolRegistry:
    def __init__(
        self,
        persona_type: PersonaType = "expert",
        *,
        enable_web_browse: bool | None = None,
        max_browses_per_cell: int | None = None,
    ) -> None:
        """Create a per-persona registry. The two cost guardrail knobs are
        passed in by the caller (the perspective agent reads them from the
        cell-level overrides) so a single study can run cells with browse
        on, cells with browse off, and cells with a custom cap. When the
        kwargs are ``None`` we fall back to settings values.
        """
        settings = get_settings()
        self.persona_type: PersonaType = persona_type
        self._b = 0
        self._q = 0
        self.browser_snippets: list[BrowserSnippet] = []
        self.duckdb_results: list[QueryResult] = []
        # Per-turn cap (resets each turn).
        self._browse_calls_this_turn = 0
        # Per-cell cap (does NOT reset; persists across turns).
        self._browse_calls_total = 0
        # web_fetch caps mirror the browse pattern (per-turn + per-cell).
        # Fetch is much cheaper than browse but Sonnet still spends a full
        # round-trip per call, so a runaway fetch loop on dead URLs is a
        # real cost vector. Caps are read from settings each dispatch so a
        # test/spec can monkeypatch get_settings to tune them.
        self._fetch_calls_this_turn = 0
        self._fetch_calls_total = 0
        # Per-URL failure cache: normalized "(host, path)" key → human
        # reason ("ssl_error", "http_404", "empty_body", …). Populated by
        # `web_fetch.fetch()` when we hand it this dict; read here on the
        # next dispatch so a verbatim retry short-circuits before any
        # network call. Lives for the registry's lifetime (= one cell).
        self._failed_urls: dict[str, str] = {}
        self._enable_web_browse: bool = (
            settings.enable_web_browse if enable_web_browse is None else bool(enable_web_browse)
        )
        self._max_browses_per_cell: int = (
            settings.max_browses_per_cell if max_browses_per_cell is None else int(max_browses_per_cell)
        )
        # Public, observable counters (asset viewer reads these).
        self.tool_call_log: list[dict[str, Any]] = []

    def start_turn(self) -> None:
        """Reset per-turn counters at the top of each `PerspectiveAgent.answer()`."""
        self._browse_calls_this_turn = 0
        self._fetch_calls_this_turn = 0

    @property
    def allowed_tool_names(self) -> set[str]:
        return _TOOLS_BY_PERSONA_TYPE.get(self.persona_type, set(_TOOLS_BY_PERSONA_TYPE["expert"]))

    @property
    def specs(self) -> list[dict[str, Any]]:
        """Anthropic tool specs filtered by persona allowlist AND by
        operational state. If `web_browse` is disabled (kill switch) or
        the per-cell cap is already exhausted, the spec is dropped from
        the list entirely so Sonnet cannot emit a `tool_use` for it on
        its next round-trip. The dispatcher's short-circuit (empty-hint
        return) stays as a safety net for in-flight calls already in the
        pipeline when state changes mid-turn."""
        allowed = self.allowed_tool_names
        browse_unavailable = (
            not self._enable_web_browse
            or self._browse_calls_total >= self._max_browses_per_cell
        )
        out: list[dict[str, Any]] = []
        for spec in TOOL_SPECS:
            if spec["name"] not in allowed:
                continue
            if spec["name"] == "web_browse" and browse_unavailable:
                continue
            out.append(spec)
        return out

    def _new_log_entry(
        self,
        *,
        tool: str,
        args: dict[str, Any] | None = None,
        cite_id: str | None = None,
    ) -> dict[str, Any]:
        """Open a partial log entry and record start timing.

        The dispatch paths below close the entry (see :meth:`_close_entry`)
        once they know the outcome. Splitting it this way means every
        log entry carries ``started_at`` / ``finished_at`` / ``latency_s``
        without each path having to track its own clock.
        """
        entry: dict[str, Any] = {
            "tool": tool,
            "args": dict(args or {}),
            "outcome": "unknown",
            "success": False,
            "started_at": _utcnow_iso(),
            "_monotonic_start": time.monotonic(),
        }
        # Mirror frequently-read fields at the top level so callers that
        # only look at ``tool``/``url``/``sql``/``query``/``cite_id``
        # (e.g. the existing tools.json reader) keep seeing them.
        if cite_id:
            entry["cite_id"] = cite_id
        if isinstance(args, dict):
            for k in ("url", "sql", "query"):
                if k in args:
                    entry[k] = args[k]
        return entry

    def _close_entry(
        self,
        entry: dict[str, Any],
        *,
        outcome: str,
        success: bool | None = None,
        n_snippets: int | None = None,
        n_rows: int | None = None,
        result_summary: str | None = None,
        reason: str | None = None,
        cite_id: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        """Close a partial log entry, attach it to ``tool_call_log``."""
        finished = time.monotonic()
        started = entry.pop("_monotonic_start", finished)
        entry["finished_at"] = _utcnow_iso()
        entry["latency_s"] = round(max(0.0, finished - started), 3)
        entry["outcome"] = outcome
        entry["success"] = (
            bool(success) if success is not None else (outcome == "ok")
        )
        if n_snippets is not None:
            entry["n_snippets"] = int(n_snippets)
        if n_rows is not None:
            entry["n_rows"] = int(n_rows)
        if result_summary:
            entry["result_summary"] = result_summary
        if reason:
            entry["reason"] = reason
        if cite_id and "cite_id" not in entry:
            entry["cite_id"] = cite_id
        if extra:
            entry.update(extra)
        self.tool_call_log.append(entry)

    async def dispatch(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name not in self.allowed_tool_names:
            return {
                "error": (
                    f"Tool `{name}` is not available to a {self.persona_type} persona. "
                    f"Available tools: {sorted(self.allowed_tool_names)}."
                )
            }

        if name == "web_browse":
            settings = get_settings()
            query = args.get("query", "")
            entry = self._new_log_entry(tool="web_browse", args=args)
            if not self._enable_web_browse:
                self._close_entry(
                    entry,
                    outcome="disabled",
                    success=False,
                    reason="web_browse disabled for this run",
                )
                return {
                    "snippets": [],
                    "query": query,
                    "hint": (
                        "`web_browse` is disabled for this run (the unattended "
                        "browser harness is unreliable against Google/.gov in "
                        "headless and every step is a paid Sonnet call). Use "
                        "`web_fetch` against a specific authoritative URL "
                        "(TTB.gov, BLS.gov, BEA.gov, FRED, Wikipedia, etc.), or "
                        "fall back to `duckdb_query` for any quantitative claim."
                    ),
                }
            if self._browse_calls_total >= self._max_browses_per_cell:
                self._close_entry(
                    entry,
                    outcome="cell_cap",
                    success=False,
                    reason="per-cell browse cap exhausted",
                )
                return {
                    "snippets": [],
                    "query": query,
                    "hint": (
                        f"`web_browse` budget for this cell is exhausted "
                        f"(cap={self._max_browses_per_cell} total). Use `web_fetch` "
                        f"against a specific URL or `duckdb_query` for the rest "
                        f"of this run. The cap protects the dollar budget."
                    ),
                }
            if self._browse_calls_this_turn >= settings.max_web_browse_per_turn:
                self._close_entry(
                    entry,
                    outcome="turn_cap",
                    success=False,
                    reason="per-turn browse cap exhausted",
                )
                return {
                    "snippets": [],
                    "query": query,
                    "hint": (
                        f"`web_browse` budget for this turn is exhausted "
                        f"(cap={settings.max_web_browse_per_turn}). Use `web_fetch` "
                        f"against a specific URL you already know, or fall back to "
                        f"`duckdb_query`. Each `web_browse` costs 60–90 s; that's why "
                        f"we cap it."
                    ),
                }
            self._browse_calls_this_turn += 1
            self._browse_calls_total += 1
            raw = await browse(query, int(args.get("max_pages", 3)))
            payload = self._assign_browser_snippets(raw, query)
            snippets = payload.get("snippets", []) or []
            result_summary = (
                snippets[0].get("title", "")[:160]
                if snippets and isinstance(snippets[0], dict)
                else ""
            )
            # Tag the entry with the first new B? cite_id so the granular
            # tool_call asset can link to the corresponding citation.
            first_cite = (
                snippets[0].get("cite_id")
                if snippets and isinstance(snippets[0], dict)
                else None
            )
            self._close_entry(
                entry,
                outcome="ok",
                success=True,
                n_snippets=len(snippets),
                result_summary=result_summary,
                cite_id=first_cite,
                extra={
                    "cite_ids": [
                        s.get("cite_id")
                        for s in snippets
                        if isinstance(s, dict) and s.get("cite_id")
                    ],
                },
            )
            return payload

        if name == "web_fetch":
            settings = get_settings()
            url = args.get("url", "")
            entry = self._new_log_entry(tool="web_fetch", args=args)
            # Per-cell cap first: an exhausted cell shouldn't even check
            # the cache, the model needs to stop fetching entirely.
            if self._fetch_calls_total >= settings.max_fetches_per_cell:
                self._close_entry(
                    entry,
                    outcome="cell_cap",
                    success=False,
                    reason="per-cell fetch cap exhausted",
                )
                return {
                    "snippets": [],
                    "query": url,
                    "hint": (
                        f"`web_fetch` budget for this cell is exhausted "
                        f"(cap={settings.max_fetches_per_cell} total). Synthesize "
                        f"from the snippets and query results you already have, or "
                        f"use `duckdb_query` for any remaining quantitative claim."
                    ),
                }
            if self._fetch_calls_this_turn >= settings.max_fetches_per_turn:
                self._close_entry(
                    entry,
                    outcome="turn_cap",
                    success=False,
                    reason="per-turn fetch cap exhausted",
                )
                return {
                    "snippets": [],
                    "query": url,
                    "hint": (
                        f"`web_fetch` budget for this turn is exhausted "
                        f"(cap={settings.max_fetches_per_turn}). Stop fetching new "
                        f"URLs this turn — synthesize from what you have or use "
                        f"`duckdb_query`. The cap protects the round-trip budget."
                    ),
                }
            # Per-URL failure cache: if we've already seen this URL fail in
            # this cell, return the cached reason immediately without a
            # network call. Stops the loop where Sonnet keeps re-fetching
            # the same dead URL across iterations.
            cache_key = _fetch_failure_key(url)
            cached_reason = self._failed_urls.get(cache_key)
            if cached_reason:
                self._close_entry(
                    entry,
                    outcome="cached_failure",
                    success=False,
                    reason=cached_reason,
                )
                return {
                    "snippets": [],
                    "query": url,
                    "hint": (
                        f"URL {url!r} already failed this cell with `{cached_reason}`; "
                        f"pick a different domain or try `duckdb_query` for a "
                        f"quantitative angle. Do not re-fetch this URL."
                    ),
                }
            self._fetch_calls_this_turn += 1
            self._fetch_calls_total += 1
            raw = await web_fetch(
                url,
                query=args.get("focus_query") or None,
                failed_urls=self._failed_urls,
            )
            # If the fetch failed, `web_fetch.fetch()` already wrote the
            # reason into `self._failed_urls[cache_key]`. Surface that as a
            # hint so the model sees WHY (not just "empty"), and so the
            # tool_call_log captures it for the asset viewer.
            if not raw:
                failure_reason = self._failed_urls.get(cache_key, "unknown")
                self._close_entry(
                    entry,
                    outcome="failed",
                    success=False,
                    reason=failure_reason,
                )
                return {
                    "snippets": [],
                    "query": url,
                    "hint": (
                        f"URL {url!r} failed with `{failure_reason}`. Pick a "
                        f"different domain or try `duckdb_query`. This URL is "
                        f"now cached as failed for the rest of this cell."
                    ),
                }
            payload = self._assign_browser_snippets(raw, url)
            snippets = payload.get("snippets", []) or []
            first_cite = (
                snippets[0].get("cite_id")
                if snippets and isinstance(snippets[0], dict)
                else None
            )
            result_summary = (
                snippets[0].get("title", "")[:160]
                if snippets and isinstance(snippets[0], dict)
                else ""
            )
            self._close_entry(
                entry,
                outcome="ok",
                success=True,
                n_snippets=len(snippets),
                result_summary=result_summary,
                cite_id=first_cite,
                extra={
                    "cite_ids": [
                        s.get("cite_id")
                        for s in snippets
                        if isinstance(s, dict) and s.get("cite_id")
                    ],
                },
            )
            return payload

        if name == "duckdb_query":
            self._q += 1
            cite_id = f"Q{self._q}"
            sql = args.get("sql", "")
            entry = self._new_log_entry(
                tool="duckdb_query", args={"sql": sql}, cite_id=cite_id
            )
            # Mirror the truncated SQL onto the entry so existing tools.json
            # readers see the same field they did before this refactor.
            entry["sql"] = (sql or "").strip()[:240]
            result = run_query(sql, cite_id=cite_id)
            self.duckdb_results.append(result)
            n_rows = len(result.rows or [])
            outcome = "error" if result.error else "ok"
            result_summary = ""
            if result.error:
                result_summary = f"error: {result.error}"
            elif result.rows:
                head = result.rows[0]
                result_summary = ", ".join(
                    f"{k}={head[k]}" for k in list(head.keys())[:4]
                )[:200]
            self._close_entry(
                entry,
                outcome=outcome,
                success=(outcome == "ok"),
                n_rows=n_rows,
                result_summary=result_summary,
                cite_id=cite_id,
                reason=result.error or None,
            )
            return result.model_dump()

        return {"error": f"Unknown tool: {name}"}

    def _assign_browser_snippets(
        self, raw: list[dict[str, str]], query_or_url: str
    ) -> dict[str, Any]:
        assigned: list[dict[str, str]] = []
        for r in raw:
            self._b += 1
            cite_id = f"B{self._b}"
            snippet = BrowserSnippet(cite_id=cite_id, **r)
            self.browser_snippets.append(snippet)
            assigned.append(snippet.model_dump())
        return {"snippets": assigned, "query": query_or_url}

    def all_citations(self) -> list[Citation]:
        out: list[Citation] = []
        for s in self.browser_snippets:
            out.append(
                Citation(
                    cite_id=s.cite_id,
                    source="browser",
                    url=s.url,
                    title=s.title,
                    snippet=s.text[:300],
                )
            )
        for q in self.duckdb_results:
            out.append(
                Citation(
                    cite_id=q.cite_id,
                    source="duckdb",
                    sql=q.sql,
                    snippet=_summarize_rows(q),
                )
            )
        return out


def _summarize_rows(q: QueryResult) -> str:
    if q.error:
        return f"(error: {q.error})"
    if not q.rows:
        return "(0 rows)"
    head = q.rows[:3]
    parts = []
    for row in head:
        parts.append(", ".join(f"{k}={v}" for k, v in row.items()))
    suffix = f" ... +{len(q.rows) - 3} more rows" if len(q.rows) > 3 else ""
    return " | ".join(parts) + suffix

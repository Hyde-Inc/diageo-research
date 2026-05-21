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
"""
from __future__ import annotations

from typing import Any

from ..config import get_settings
from ..models import BrowserSnippet, Citation, PersonaType, QueryResult
from .browser import browse
from .duckdb_tool import run_query
from .web_fetch import TOOL_SPEC as WEB_FETCH_SPEC
from .web_fetch import fetch as web_fetch

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
    def __init__(self, persona_type: PersonaType = "expert") -> None:
        self.persona_type: PersonaType = persona_type
        self._b = 0
        self._q = 0
        self.browser_snippets: list[BrowserSnippet] = []
        self.duckdb_results: list[QueryResult] = []
        self._browse_calls_this_turn = 0

    def start_turn(self) -> None:
        """Reset per-turn counters at the top of each `PerspectiveAgent.answer()`."""
        self._browse_calls_this_turn = 0

    @property
    def allowed_tool_names(self) -> set[str]:
        return _TOOLS_BY_PERSONA_TYPE.get(self.persona_type, set(_TOOLS_BY_PERSONA_TYPE["expert"]))

    @property
    def specs(self) -> list[dict[str, Any]]:
        allowed = self.allowed_tool_names
        return [s for s in TOOL_SPECS if s["name"] in allowed]

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
            if self._browse_calls_this_turn >= settings.max_web_browse_per_turn:
                return {
                    "snippets": [],
                    "query": args.get("query", ""),
                    "hint": (
                        f"`web_browse` budget for this turn is exhausted "
                        f"(cap={settings.max_web_browse_per_turn}). Use `web_fetch` "
                        f"against a specific URL you already know, or fall back to "
                        f"`duckdb_query`. Each `web_browse` costs 60–90 s; that's why "
                        f"we cap it."
                    ),
                }
            self._browse_calls_this_turn += 1
            raw = await browse(args.get("query", ""), int(args.get("max_pages", 3)))
            return self._assign_browser_snippets(raw, args.get("query", ""))

        if name == "web_fetch":
            raw = await web_fetch(
                args.get("url", ""),
                query=args.get("focus_query") or None,
            )
            return self._assign_browser_snippets(raw, args.get("url", ""))

        if name == "duckdb_query":
            self._q += 1
            cite_id = f"Q{self._q}"
            result = run_query(args.get("sql", ""), cite_id=cite_id)
            self.duckdb_results.append(result)
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

"""Follow-up Q&A agent — context-only single-shot answers about a delivered brief.

Loads the persisted final brief + per-persona sub-reports + citation table off
disk and streams a single Anthropic call back as typed chunks. No tools (no
DuckDB, no web), no panel re-run, no `runs/` writes — purely a read-from-disk
helper that lets a partner ask follow-ups about the just-shipped brief.

Public surface:

    async def answer_followup(run_id, question, settings) -> AsyncIterator[FollowupChunk]

Yields:
- `FollowupChunk(type="token", text="...")` — incremental answer text from
  Anthropic's streaming API, one chunk per delta.
- `FollowupChunk(type="done", citations_used=["S4", "S6", ...])` — terminal
  marker with the list of `[S?]` markers the answer cited (extracted from the
  full streamed text).
- `FollowupChunk(type="error", message="...")` — emitted instead of `done`
  if the LLM call fails, so the SSE consumer can render the error inline.

Design notes:
- `final.json` already carries the renumbered global `[S?]` citations the
  brief uses; we render that table verbatim into the prompt so the LLM can
  only cite IDs that actually exist.
- Sub-reports give the LLM the data the synthesizer dropped (e.g. minor
  cohort splits that didn't make the main brief), so a partner can drill
  down without re-running the panel.
- Stream output for nice chat UX even though the underlying call is one
  Anthropic message — the latency is hidden behind tokens appearing live.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, Literal

from anthropic import AsyncAnthropic
from pydantic import BaseModel, Field

from .citations import extract_markers
from .config import Settings, get_settings
from .prompt_loader import render

logger = logging.getLogger(__name__)


class FollowupChunk(BaseModel):
    """One unit emitted by `answer_followup` — either a streaming token, a
    terminal `done` marker with cited IDs, or an error message."""

    type: Literal["token", "done", "error"]
    text: str = ""
    citations_used: list[str] = Field(default_factory=list)
    message: str = ""


@dataclass
class _FollowupContext:
    final_brief_md: str
    sub_reports_md: str
    citations_table: str


def _load_context(run_dir: Path) -> _FollowupContext:
    """Load the brief + sub-reports + citation table off disk. Raises
    `FileNotFoundError` if the run hasn't finished synthesizing yet."""
    final_path = run_dir / "final.json"
    if not final_path.exists():
        raise FileNotFoundError(f"final.json not found at {final_path}")

    import json

    final = json.loads(final_path.read_text(encoding="utf-8"))
    final_brief_md: str = final.get("markdown") or ""
    citations: list[dict] = final.get("citations") or []

    # Glob persona sub-reports. Each persona directory looks like `p1/`, `p2/`...
    # — each contains `subreport.md` written by the orchestrator's
    # `_interview_persona` step.
    sub_reports: list[str] = []
    for persona_dir in sorted(run_dir.iterdir()):
        if not persona_dir.is_dir():
            continue
        sub_path = persona_dir / "subreport.md"
        if not sub_path.exists():
            continue
        sub_reports.append(sub_path.read_text(encoding="utf-8").strip())

    return _FollowupContext(
        final_brief_md=final_brief_md,
        sub_reports_md="\n\n---\n\n".join(sub_reports) if sub_reports else "_(no sub-reports persisted)_",
        citations_table=_render_citations_table(citations),
    )


def _render_citations_table(citations: list[dict]) -> str:
    """Render the global citation list as a compact markdown table the LLM
    can cite verbatim. Falls through to a placeholder if the brief has none.
    """
    if not citations:
        return "_(no citations in this run — answer purely from the brief prose if at all)_"

    lines = ["| ID | Source | Reference | Verified |", "|---|---|---|---|"]
    for c in citations:
        cite_id = c.get("cite_id") or ""
        source = c.get("source") or ""
        if source == "browser":
            ref = c.get("title") or c.get("url") or ""
        elif source == "duckdb":
            sql = (c.get("sql") or "").replace("\n", " ").strip()
            ref = sql[:140] + ("…" if len(sql) > 140 else "")
        else:
            ref = c.get("snippet") or ""
        verified_raw = c.get("verified")
        verified = (
            "✓"
            if verified_raw is True
            else "⚠"
            if verified_raw is False
            else "—"
        )
        # Pipe-escape any literal pipes in the reference so the markdown table
        # doesn't get mangled when the LLM reads it back.
        ref_safe = ref.replace("|", "\\|")
        lines.append(f"| [{cite_id}] | {source} | {ref_safe} | {verified} |")
    return "\n".join(lines)


async def answer_followup(
    run_id: str,
    question: str,
    settings: Settings | None = None,
) -> AsyncIterator[FollowupChunk]:
    """Stream a follow-up answer about the brief identified by `run_id`.

    Loads brief + sub-reports + citation table once, calls Anthropic with
    `stream=True`, yields `FollowupChunk` deltas. Terminal `done` chunk
    carries the `[S?]` markers the answer cited (extracted from the full
    streamed text).
    """
    settings = settings or get_settings()
    run_dir = settings.runs_dir / run_id

    try:
        ctx = _load_context(run_dir)
    except FileNotFoundError as e:
        logger.warning("followup: missing context for run %s: %s", run_id, e)
        yield FollowupChunk(
            type="error",
            message="No final brief on disk for this run yet — the run must complete synthesis before follow-up Q&A is available.",
        )
        return

    prompt = render(
        "followup",
        question=question.strip(),
        final_brief=ctx.final_brief_md,
        sub_reports=ctx.sub_reports_md,
        citations_table=ctx.citations_table,
    )

    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    accumulated: list[str] = []

    try:
        async with client.messages.stream(
            model=settings.sonnet_model_id,
            max_tokens=1500,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            async for text in stream.text_stream:
                if not text:
                    continue
                accumulated.append(text)
                yield FollowupChunk(type="token", text=text)
    except Exception as e:  # noqa: BLE001 — network / Anthropic failure
        logger.exception("followup: anthropic stream failed for run %s", run_id)
        yield FollowupChunk(
            type="error",
            message=f"LLM call failed: {e}",
        )
        return

    full_text = "".join(accumulated)
    yield FollowupChunk(
        type="done",
        citations_used=extract_markers(full_text),
    )

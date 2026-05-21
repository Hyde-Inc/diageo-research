"""Interviewer/perspective shared dialogue memory.

Holds the full list of turns plus a rolling summary that is refreshed every N turns
via a cheap Sonnet call. Mirrors STORM's rolling-context window approach so the
interviewer can ask informed follow-up questions without unbounded context growth.
"""
from __future__ import annotations

from anthropic import AsyncAnthropic

from .config import get_settings
from .models import DialogueTurn


class DialogueMemory:
    def __init__(self) -> None:
        self.turns: list[DialogueTurn] = []
        self.rolling_summary: str = ""

    def append(self, turn: DialogueTurn) -> None:
        self.turns.append(turn)

    def context_block(self, window: int = 4) -> str:
        recent = self.turns[-window:]
        lines: list[str] = []
        if self.rolling_summary:
            lines.append("## Earlier conversation summary")
            lines.append(self.rolling_summary)
            lines.append("")
        if recent:
            lines.append("## Recent turns")
            for t in recent:
                cites = ", ".join(c.cite_id for c in t.citations) or "—"
                lines.append(f"### Turn {t.turn_idx}")
                lines.append(f"Q: {t.question}")
                lines.append(f"A: {t.answer}")
                lines.append(f"(cites: {cites})")
                lines.append("")
        return "\n".join(lines).strip()

    async def refresh_summary_if_needed(
        self,
        client: AsyncAnthropic,
        every: int | None = None,
    ) -> None:
        settings = get_settings()
        every = every or settings.summary_refresh_every
        if not self.turns or len(self.turns) % every != 0:
            return
        history = "\n\n".join(f"Q: {t.question}\nA: {t.answer}" for t in self.turns)
        prompt = (
            "Summarize the following interviewer-perspective dialogue in under 200 words. "
            "Preserve named entities, numbers, and citation IDs verbatim. Output plain prose, "
            "no headings or lists.\n\n"
            f"{history}"
        )
        resp = await client.messages.create(
            model=settings.sonnet_model_id,
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )
        self.rolling_summary = "".join(
            b.text for b in resp.content if getattr(b, "type", None) == "text"
        ).strip()

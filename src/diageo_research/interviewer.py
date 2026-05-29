"""Interviewer agent.

Two interview modes coexist for backward compatibility:

1. **Framing-driven (default when framings are supplied).** The
   orchestrator generates 2–4 alternate framings of the user's question
   at question-analysis time, and we ask each respondent the SAME
   framings in order. Each turn is a deterministic pull from the
   `framings` list — no LLM call is needed to pick the next question, so
   each interview's wall-time is bounded and the answers across cohorts
   are directly comparable per framing. STOP fires when every framing
   has been asked.

2. **Checklist-driven (legacy fallback when framings are empty).** The
   interviewer uses Sonnet to pick the next question off the persona's
   uncovered checklist + assigned sections. Kept for runs without
   framings (older saved plans, CLI-only smoke tests, etc.).

The new default — framing-driven — is what the partner sees in the FE:
each turn is tagged with `framing_idx` so the UI can render
`Framing 2/3: <text>` next to the persona card.
"""
from __future__ import annotations

import logging

from anthropic import AsyncAnthropic

from .config import get_settings
from .memory import DialogueMemory
from .models import Persona
from .prompt_loader import render

logger = logging.getLogger(__name__)


class Interviewer:
    def __init__(
        self,
        client: AsyncAnthropic,
        persona: Persona,
        question: str,
        memory: DialogueMemory,
        framings: list[str] | None = None,
    ) -> None:
        self.client = client
        self.persona = persona
        self.question = question
        self.memory = memory
        self.framings = list(framings or [])
        # Index of the next framing to ask. When the framings list is
        # supplied, the interviewer returns framings[i] deterministically
        # on each call until exhausted.
        self._framing_idx = 0

    async def next_question(self) -> tuple[str, int | None] | None:
        """Return `(question_text, framing_idx)` or None to STOP.

        `framing_idx` is the 0-based index in `self.framings` for
        framing-driven mode, or None for legacy checklist-driven turns.
        """
        if self.framings:
            return self._next_framing()
        return await self._next_checklist_question()

    def _next_framing(self) -> tuple[str, int] | None:
        if self._framing_idx >= len(self.framings):
            return None
        framing = self.framings[self._framing_idx]
        idx = self._framing_idx
        self._framing_idx += 1
        return framing, idx

    async def _next_checklist_question(self) -> tuple[str, None] | None:
        settings = get_settings()
        prompt = render(
            "interviewer",
            persona_card=self._persona_card(),
            section_assignments_block=self._section_assignments_block(),
            checklist_block=self._checklist_block(),
            question=self.question,
            context_block=self.memory.context_block(settings.memory_window) or "(no turns yet)",
        )
        resp = await self.client.messages.create(
            model=settings.sonnet_model_id,
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(
            b.text for b in resp.content if getattr(b, "type", None) == "text"
        ).strip()
        if not text:
            return None
        if text.upper().split()[0].rstrip(".") == "STOP":
            return None
        return text, None

    def _persona_card(self) -> str:
        # Lead with the demographic + SKU anchor — that's how the partner reads
        # the panel in the FE — then back it with the analyst-style metadata.
        bits: list[str] = []
        if self.persona.demographic:
            bits.append(f"**Demographic:** {self.persona.demographic}")
        if self.persona.sku_focus:
            bits.append(f"**SKU focus:** {self.persona.sku_focus}")
        bits.extend(
            [
                f"**Name:** {self.persona.name}",
                f"**Role:** {self.persona.role}",
                f"**Lens:** {self.persona.lens}",
                f"**Background:** {self.persona.description}",
            ]
        )
        return "\n".join(bits)

    def _section_assignments_block(self) -> str:
        if not self.persona.section_assignments:
            return "(no specific assignments — cover the brief broadly)"
        return "\n".join(f"- {s}" for s in self.persona.section_assignments)

    def _checklist_block(self) -> str:
        if not self.persona.checklist:
            return "(no checklist supplied — judge coverage by your own sense of breadth)"
        return "\n".join(f"- [ ] {item}" for item in self.persona.checklist)

"""Interviewer agent: reads dialogue memory and asks the next question (Sonnet 4.6).

Now checklist-aware: the interviewer is shown the persona's research checklist
and assigned outline sections, and is told to keep asking until those are
covered. This makes STOP an objective signal rather than a vibes-based one
(improvement #1).
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
    ) -> None:
        self.client = client
        self.persona = persona
        self.question = question
        self.memory = memory

    async def next_question(self) -> str | None:
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
        return text

    def _persona_card(self) -> str:
        return (
            f"**Name:** {self.persona.name}\n"
            f"**Type:** {self.persona.persona_type}\n"
            f"**Role:** {self.persona.role}\n"
            f"**Lens:** {self.persona.lens}\n"
            f"**Background:** {self.persona.description}"
        )

    def _section_assignments_block(self) -> str:
        if not self.persona.section_assignments:
            return "(no specific assignments — cover the brief broadly)"
        return "\n".join(f"- {s}" for s in self.persona.section_assignments)

    def _checklist_block(self) -> str:
        if not self.persona.checklist:
            return "(no checklist supplied — judge coverage by your own sense of breadth)"
        return "\n".join(f"- [ ] {item}" for item in self.persona.checklist)

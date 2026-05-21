"""Outline-first orchestration (improvement #2).

STORM §3.3 generates the article outline BEFORE the interviews so each persona's
conversation can be steered toward the sections they are best positioned to cover.
This module:

1. Drafts a seed outline from the question + persona cards (no research yet).
2. Assigns 1–2 outline sections to each persona.
3. Returns the section list for the parallel section-writers downstream.
"""
from __future__ import annotations

import logging

from anthropic import AsyncAnthropic

from .config import get_settings
from .json_utils import ParseFailure, parse_json
from .models import OutlineSection, Persona
from .prompt_loader import render

logger = logging.getLogger(__name__)


async def draft_seed_outline(
    client: AsyncAnthropic,
    question: str,
    personas: list[Persona],
    dataset_schema: str,
) -> tuple[str, list[OutlineSection]]:
    settings = get_settings()
    personas_block = _personas_block(personas)
    prompt = render(
        "outline_seed",
        question=question,
        personas_block=personas_block,
        dataset_schema=dataset_schema,
    )
    resp = await client.messages.create(
        model=settings.opus_model_id,
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
    )
    text = "".join(
        b.text for b in resp.content if getattr(b, "type", None) == "text"
    ).strip()
    try:
        obj = parse_json(text, expecting="object")
    except ParseFailure as pe:
        raise RuntimeError(f"Seed outline returned unparseable JSON: {pe.message}") from pe
    executive_intent = str(obj.get("executive_intent", "")).strip()
    sections: list[OutlineSection] = []
    for s in obj.get("sections", []) or []:
        if isinstance(s, dict) and str(s.get("heading", "")).strip():
            sections.append(
                OutlineSection(
                    heading=str(s["heading"]).strip(),
                    intent=str(s.get("intent", "")).strip(),
                )
            )
        elif isinstance(s, str) and s.strip():
            sections.append(OutlineSection(heading=s.strip()))
    if not sections:
        sections = [OutlineSection(heading="Key findings")]
    return executive_intent, sections


async def assign_sections(
    client: AsyncAnthropic,
    question: str,
    personas: list[Persona],
    sections: list[OutlineSection],
) -> dict[str, list[str]]:
    """Return mapping persona_id → list of assigned section headings. Falls back
    to a round-robin assignment if the LLM returns garbage."""
    settings = get_settings()
    personas_block = _personas_block(personas)
    sections_block = "\n".join(
        f"- **{s.heading}** — {s.intent}" if s.intent else f"- **{s.heading}**"
        for s in sections
    )
    prompt = render(
        "assign_sections",
        question=question,
        personas_block=personas_block,
        sections_block=sections_block,
    )
    try:
        resp = await client.messages.create(
            model=settings.sonnet_model_id,
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(
            b.text for b in resp.content if getattr(b, "type", None) == "text"
        ).strip()
        try:
            obj = parse_json(text, expecting="object")
        except ParseFailure as pe:
            raise ValueError(f"resilient JSON parse failed: {pe.message}") from pe
        valid_headings = {s.heading for s in sections}
        out: dict[str, list[str]] = {}
        for pid, headings in obj.items():
            if not isinstance(headings, list):
                continue
            kept = [str(h).strip() for h in headings if str(h).strip() in valid_headings]
            if kept:
                out[pid] = kept[:2]
        if out:
            return _ensure_full_coverage(out, personas, sections)
    except Exception as e:  # noqa: BLE001
        logger.warning("assign_sections LLM call failed (%s); falling back to round-robin", e)
    return _round_robin(personas, sections)


def _ensure_full_coverage(
    assignment: dict[str, list[str]],
    personas: list[Persona],
    sections: list[OutlineSection],
) -> dict[str, list[str]]:
    covered = {h for hs in assignment.values() for h in hs}
    missing = [s.heading for s in sections if s.heading not in covered]
    if not missing:
        return assignment
    persona_ids = [p.id for p in personas]
    if not persona_ids:
        return assignment
    for i, h in enumerate(missing):
        pid = persona_ids[i % len(persona_ids)]
        existing = assignment.setdefault(pid, [])
        if h not in existing:
            existing.append(h)
    return assignment


def _round_robin(
    personas: list[Persona], sections: list[OutlineSection]
) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {p.id: [] for p in personas}
    if not personas:
        return out
    for i, s in enumerate(sections):
        out[personas[i % len(personas)].id].append(s.heading)
    return out


def _personas_block(personas: list[Persona]) -> str:
    lines: list[str] = []
    for p in personas:
        lines.append(
            f"- **{p.id}** ({p.persona_type}) — {p.name}: {p.role}. "
            f"Lens: {p.lens}"
        )
    return "\n".join(lines)

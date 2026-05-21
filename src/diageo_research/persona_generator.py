"""Generate N diverse perspective personas from a user question (Opus 4.7).

The panel is analyst-only by design: every persona is an expert with a
lens-specific anchor (Gen Z behaviour, Hispanic household consumption,
on-premise channel, control-state pricing, etc.). Each persona carries a
5–8 item checklist used by the interviewer to gate STOP.

Robustness: Opus occasionally returns JSON with a missing comma between
objects in the array. We use `json_utils.parse_json` (which repairs common
LLM mistakes — trailing commas, smart quotes, raw newlines in strings, etc.)
and on a hard failure we retry ONCE with the parse error appended so the
model can self-correct.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import cast

from anthropic import AsyncAnthropic

from .config import get_settings
from .json_utils import ParseFailure, parse_json
from .models import Persona, QuestionPlan
from .prompt_loader import render

logger = logging.getLogger(__name__)


async def generate_personas(
    client: AsyncAnthropic,
    question: str,
    n: int,
    plan: QuestionPlan | None = None,
    debug_dir: Path | None = None,
) -> list[Persona]:
    """Generate the panel. If `plan` is supplied, its seed perspectives anchor
    the generation so the panel cannot drift off-brief.

    If `debug_dir` is supplied, broken LLM responses are persisted there for
    postmortem (`debug/01_personas_raw.txt`)."""
    settings = get_settings()
    plan_block = _plan_block(plan)
    prompt = render("persona_gen", question=question, n=n, plan_block=plan_block)

    raw = await _call(client, settings.opus_model_id, prompt, max_tokens=6000)
    try:
        data = parse_json(raw, expecting="array")
    except ParseFailure as e:
        logger.warning(
            "persona_generator: first parse failed (%s); retrying with self-correction",
            e.message,
        )
        _persist_debug(debug_dir, "01_personas_raw_attempt1.txt", raw)
        retry_prompt = (
            prompt
            + "\n\n---\nIMPORTANT: your previous response failed to parse as JSON. "
            f"The parser reported: `{e.message}`. Return ONLY a valid JSON array "
            f"with exactly {n} objects, no surrounding prose, no markdown fence. "
            "Use only ASCII double quotes for strings. Escape any embedded newlines."
        )
        raw_retry = await _call(client, settings.opus_model_id, retry_prompt, max_tokens=6000)
        try:
            data = parse_json(raw_retry, expecting="array")
        except ParseFailure as e2:
            _persist_debug(debug_dir, "01_personas_raw_attempt2.txt", raw_retry)
            raise RuntimeError(
                f"Persona generator returned unparseable JSON twice. "
                f"First error: {e.message}. Retry error: {e2.message}. "
                f"Raw responses saved in debug dir if provided."
            ) from e2

    if not isinstance(data, list):
        raise RuntimeError(f"Persona generator returned non-list JSON: {type(data).__name__}")

    personas: list[Persona] = []
    for i, row in enumerate(data[:n]):
        if not isinstance(row, dict):
            continue
        # All personas are analysts by design (see prompts/persona_gen.md).
        # The persona_type field is kept for back-compat / future experiments
        # but always coerced to "expert" here so the panel cannot drift back
        # into synthetic consumer personas without an explicit code change.
        persona_type = "expert"
        checklist_raw = row.get("checklist") or []
        checklist = [str(c).strip() for c in checklist_raw if str(c).strip()]
        personas.append(
            Persona(
                id=f"p{i + 1}",
                name=str(row.get("name", f"Persona {i + 1}")),
                role=str(row.get("role", "")),
                lens=str(row.get("lens", "")),
                description=str(row.get("description", "")),
                system_prompt=str(row.get("system_prompt", "")),
                persona_type=persona_type,  # type: ignore[arg-type]
                checklist=checklist,
            )
        )
    return _validate_diversity(personas, n)


async def _call(
    client: AsyncAnthropic, model: str, prompt: str, max_tokens: int
) -> str:
    resp = await client.messages.create(
        model=model,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(
        b.text for b in resp.content if getattr(b, "type", None) == "text"
    ).strip()


def _persist_debug(debug_dir: Path | None, filename: str, text: str) -> None:
    if debug_dir is None:
        return
    try:
        debug_dir.mkdir(parents=True, exist_ok=True)
        (debug_dir / filename).write_text(text, encoding="utf-8")
        logger.info("persona_generator: saved broken response to %s", debug_dir / filename)
    except Exception as e:  # noqa: BLE001
        logger.debug("persona_generator: failed to persist debug file %s: %s", filename, e)


def _validate_diversity(personas: list[Persona], n: int) -> list[Persona]:
    """Drop duplicates. For experts we deduplicate by normalized role family.
    Consumers can share role wording ('shopper', 'drinker'); we dedupe them by
    their full *name* anchor instead (which encodes their demographic).
    Raise if fewer than min(n, 2) distinct personas remain."""
    seen_expert: set[str] = set()
    seen_consumer: set[str] = set()
    out: list[Persona] = []
    for p in personas:
        if p.persona_type == "consumer":
            key = _normalize_consumer(p.name) or _normalize_role(p.role)
            if not key or key in seen_consumer:
                continue
            seen_consumer.add(key)
        else:
            key = _normalize_role(p.role) or _normalize_role(p.name)
            if not key or key in seen_expert:
                continue
            seen_expert.add(key)
        out.append(p)
    minimum = min(n, 2)
    if len(out) < minimum:
        roles = [(p.persona_type, p.role) for p in personas]
        raise RuntimeError(
            f"Persona generator produced too few diverse personas (got {len(out)}, "
            f"need {minimum}): {roles}"
        )
    return out


def _normalize_role(role: str) -> str:
    role = role.lower()
    role = re.sub(r"[^a-z0-9 ]", " ", role)
    role = re.sub(r"\s+", " ", role).strip()
    for stop in ("senior", "junior", "principal", "lead", "head of", "vp of", "director of"):
        role = role.replace(stop, "").strip()
    for tail in ("strategist", "analyst", "manager", "lead", "researcher", "expert"):
        if role.endswith(" " + tail):
            role = role[: -(len(tail) + 1)]
    return role.strip()


def _normalize_consumer(name: str) -> str:
    """Consumer personas dedupe on their full name anchor (e.g.
    'Marisol, 26, Houston tequila buyer'). Two consumers from the same
    city + age bracket + category should be treated as duplicates."""
    s = name.lower()
    s = re.sub(r"[^a-z0-9 ,]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _plan_block(plan: QuestionPlan | None) -> str:
    """Render the question plan as a markdown block for the persona generator."""
    if plan is None:
        return (
            "_(no upstream analysis — you have full latitude on the panel mix)_"
        )
    lines: list[str] = []
    lines.append(
        f"- **Complexity:** {plan.complexity} (score {plan.complexity_score}/5)"
    )
    lines.append(f"- **Recommended panel size:** {plan.recommended_personas}")
    if plan.axes:
        lines.append("- **Strategic axes the panel must cover:** " + ", ".join(plan.axes))
    if plan.sub_questions:
        lines.append("- **Sub-questions to keep in mind:**")
        for sq in plan.sub_questions:
            lines.append(f"  - {sq}")
    if plan.must_have_perspectives:
        lines.append("- **Seed perspectives (one persona per seed):**")
        for i, sp in enumerate(plan.must_have_perspectives, 1):
            lines.append(
                f"  {i}. _{sp.persona_type}_ — **{sp.anchor}** "
                f"(why: {sp.why})"
            )
    if plan.rationale:
        lines.append(f"- **Rationale:** {plan.rationale}")
    return "\n".join(lines)

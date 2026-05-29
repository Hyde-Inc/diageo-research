"""Upfront question analysis (Opus) — decide who needs to be in the room.

A 1-call pass that runs BEFORE persona generation. Outputs a `QuestionPlan`:

- complexity classification (narrow → open_ended)
- recommended persona count (2–8)
- the strategic axes the question touches
- seed perspectives — short briefs the persona generator uses as anchors so it
  cannot drift off-brief
- sub-question decomposition for later use

Cost: one Opus call (~5–10 s, ~$0.02). Pays back many times over because every
downstream stage (personas, outline, interviews, synthesis) is better-targeted.
"""
from __future__ import annotations

import logging
from typing import cast

from anthropic import AsyncAnthropic

from .config import get_settings
from .json_utils import ParseFailure, parse_json
from .models import ComplexityLevel, PerspectiveSpec, QuestionPlan
from .prompt_loader import render

logger = logging.getLogger(__name__)

# Sizing heuristic — matches the prompt; used as the fallback when the LLM
# call fails or returns garbage so the pipeline never blocks on this.
_DEFAULT_PERSONAS_BY_SCORE: dict[int, int] = {1: 2, 2: 3, 3: 4, 4: 5, 5: 6}
_DEFAULT_COMPLEXITY_BY_SCORE: dict[int, ComplexityLevel] = {
    1: "narrow",
    2: "focused",
    3: "moderate",
    4: "broad",
    5: "open_ended",
}


async def analyze_question(
    client: AsyncAnthropic,
    question: str,
    persona_override: int | None = None,
) -> QuestionPlan:
    """Return a `QuestionPlan` for `question`. If `persona_override` is given
    (CLI `--personas N`), the recommendation is overridden and the seed
    perspective list is trimmed/padded to match — the analysis still runs so
    the persona generator gets axes + seed anchors."""
    settings = get_settings()
    prompt = render("question_analysis", question=question)

    plan: QuestionPlan | None = None
    try:
        resp = await client.messages.create(
            model=settings.opus_model_id,
            max_tokens=2000,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(
            b.text for b in resp.content if getattr(b, "type", None) == "text"
        ).strip()
        try:
            obj = parse_json(text, expecting="object")
        except ParseFailure as pe:
            raise ValueError(f"resilient JSON parse failed: {pe.message}") from pe
        plan = _parse_plan(obj)
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "question_analysis: LLM call failed (%s); using moderate fallback plan", e
        )
        plan = _fallback_plan()

    plan = _apply_override(plan, persona_override)
    logger.info(
        "question_analysis: complexity=%s score=%d recommended=%d axes=%s",
        plan.complexity, plan.complexity_score, plan.recommended_personas, plan.axes,
    )
    return plan


# --------------------------------------------------------------------- parsing


def _parse_plan(obj: dict) -> QuestionPlan:
    score_raw = obj.get("complexity_score", 3)
    try:
        score = max(1, min(5, int(score_raw)))
    except (TypeError, ValueError):
        score = 3
    complexity = obj.get("complexity")
    if complexity not in ("narrow", "focused", "moderate", "broad", "open_ended"):
        complexity = _DEFAULT_COMPLEXITY_BY_SCORE[score]
    recommended_raw = obj.get("recommended_personas", _DEFAULT_PERSONAS_BY_SCORE[score])
    try:
        recommended = max(2, min(8, int(recommended_raw)))
    except (TypeError, ValueError):
        recommended = _DEFAULT_PERSONAS_BY_SCORE[score]

    axes = [str(a).strip() for a in obj.get("axes", []) or [] if str(a).strip()]
    sub_qs = [str(q).strip() for q in obj.get("sub_questions", []) or [] if str(q).strip()]
    framings = [str(f).strip() for f in obj.get("framings", []) or [] if str(f).strip()]
    specs: list[PerspectiveSpec] = []
    for row in obj.get("must_have_perspectives", []) or []:
        if not isinstance(row, dict):
            continue
        # All panels are analyst-only by design. The `persona_type` field
        # stays in the model for back-compat / future experiments, but the
        # analyzer always coerces to "expert" so the LLM cannot accidentally
        # reintroduce synthetic consumer personas.
        pt_raw = "expert"
        anchor = str(row.get("anchor", "")).strip()
        why = str(row.get("why", "")).strip()
        if not anchor:
            continue
        specs.append(PerspectiveSpec(
            persona_type=cast(object, pt_raw),  # type: ignore[arg-type]
            anchor=anchor,
            why=why or "(no rationale supplied)",
        ))

    return QuestionPlan(
        complexity=cast(ComplexityLevel, complexity),
        complexity_score=score,
        recommended_personas=recommended,
        axes=axes,
        must_have_perspectives=specs,
        sub_questions=sub_qs,
        rationale=str(obj.get("rationale", "")).strip(),
        framings=framings,
    )


def _fallback_plan() -> QuestionPlan:
    """When the analyzer call fails, fall back to the existing default."""
    return QuestionPlan(
        complexity="moderate",
        complexity_score=3,
        recommended_personas=4,
        axes=["geography", "demographics", "category", "channel"],
        must_have_perspectives=[],
        sub_questions=[],
        rationale="LLM analysis unavailable; using moderate-default 4-persona panel.",
    )


def _apply_override(plan: QuestionPlan, override: int | None) -> QuestionPlan:
    """Apply the user's `--personas N` override. The seed perspectives list is
    trimmed (extra ones dropped) or padded (missing ones flagged so the persona
    generator knows it has free slots to fill)."""
    if override is None:
        return plan
    override = max(2, min(8, override))
    if override == plan.recommended_personas:
        return plan
    specs = list(plan.must_have_perspectives)
    if len(specs) > override:
        specs = specs[:override]
    return plan.model_copy(
        update={
            "recommended_personas": override,
            "must_have_perspectives": specs,
            "rationale": (
                plan.rationale + f" (user override: --personas {override})"
            ).strip(),
        }
    )



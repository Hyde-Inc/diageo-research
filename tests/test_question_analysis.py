"""Tests for question_analysis: parsing, override behaviour, fallback path."""
import pytest

from diageo_research.models import PerspectiveSpec, QuestionPlan
from diageo_research.question_analysis import (
    _apply_override,
    _fallback_plan,
    _parse_plan,
    analyze_question,
)


def test_parse_plan_clamps_and_normalises_and_forces_expert():
    """Even if the LLM tries to return `persona_type: consumer`, the analyzer
    now coerces every persona to `expert`. The panel is analyst-only by design."""
    obj = {
        "complexity": "wildly_open",  # invalid → falls back to score's default
        "complexity_score": 8,        # clamped to 5
        "recommended_personas": 99,   # clamped to 8
        "axes": ["geography", "  "],   # blanks dropped
        "must_have_perspectives": [
            {"persona_type": "CONSUMER", "anchor": "A1", "why": "w1"},  # forced to expert
            {"persona_type": "manager", "anchor": "A2", "why": "w2"},   # forced to expert
            {"anchor": "", "why": "skip me"},                             # empty anchor → skipped
        ],
        "sub_questions": ["q1", "", "  q2  "],
        "rationale": "because",
    }
    plan = _parse_plan(obj)
    assert plan.complexity_score == 5
    assert plan.complexity == "open_ended"
    assert plan.recommended_personas == 8
    assert plan.axes == ["geography"]
    assert len(plan.must_have_perspectives) == 2
    # Both perspectives are now expert (no more consumer in default flow).
    assert all(p.persona_type == "expert" for p in plan.must_have_perspectives)
    assert plan.sub_questions == ["q1", "q2"]
    assert plan.rationale == "because"


def test_parse_plan_handles_garbage_gracefully():
    plan = _parse_plan({})
    # Defaults: score=3, complexity=moderate, recommended=4
    assert plan.complexity_score == 3
    assert plan.complexity == "moderate"
    assert plan.recommended_personas == 4


def test_apply_override_trims_excess_seeds():
    plan = QuestionPlan(
        complexity="broad",
        complexity_score=4,
        recommended_personas=6,
        must_have_perspectives=[
            PerspectiveSpec(persona_type="consumer", anchor=f"A{i}", why="w") for i in range(6)
        ],
    )
    out = _apply_override(plan, 3)
    assert out.recommended_personas == 3
    assert len(out.must_have_perspectives) == 3


def test_apply_override_clamps_to_bounds():
    plan = QuestionPlan(complexity="moderate", complexity_score=3, recommended_personas=4)
    assert _apply_override(plan, 0).recommended_personas == 2
    assert _apply_override(plan, 99).recommended_personas == 8
    assert _apply_override(plan, None).recommended_personas == 4


def test_apply_override_noop_when_matches():
    plan = QuestionPlan(complexity="moderate", complexity_score=3, recommended_personas=4)
    out = _apply_override(plan, 4)
    assert out is plan or out.recommended_personas == 4


def test_fallback_plan_is_safe_default():
    p = _fallback_plan()
    assert 2 <= p.recommended_personas <= 8
    assert p.complexity in ("narrow", "focused", "moderate", "broad", "open_ended")


@pytest.mark.asyncio
async def test_analyze_question_uses_fallback_on_llm_failure(monkeypatch):
    """If the Opus call raises, the analyzer must NOT propagate — it falls
    back to the moderate default so the pipeline can continue."""

    class _BoomClient:
        class messages:
            @staticmethod
            async def create(*a, **k):
                raise RuntimeError("api unavailable")

    plan = await analyze_question(_BoomClient(), "What is X?")  # type: ignore[arg-type]
    assert plan.recommended_personas == 4  # fallback default
    assert plan.complexity == "moderate"

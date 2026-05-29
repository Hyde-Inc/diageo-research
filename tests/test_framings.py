"""Tests for the multi-framing interview flow + framings plumbing."""
from __future__ import annotations

import pytest

from diageo_research.interviewer import Interviewer
from diageo_research.memory import DialogueMemory
from diageo_research.models import Persona, PlanEdit, PlanForReview
from diageo_research.question_analysis import _parse_plan
from diageo_research import hitl


def _persona() -> Persona:
    return Persona(
        id="p1",
        name="Gen Z LA × Don Julio",
        role="Gen Z Latino off-premise tequila respondent",
        lens="Watches Gen Z Latino spend on premium tequila in SoCal.",
        description="d",
        system_prompt="sp",
        demographic="Gen Z Latino, LA / Houston, weekend off-premise",
        sku_focus="Don Julio Blanco 750ml",
    )


@pytest.mark.asyncio
async def test_interviewer_framing_driven_returns_each_framing_in_order():
    framings = [
        "Framing 1: data-first restatement",
        "Framing 2: decision-first restatement",
        "Framing 3: counterfactual restatement",
    ]
    iv = Interviewer(
        client=None,  # framing mode never calls the LLM
        persona=_persona(),
        question="Q?",
        memory=DialogueMemory(),
        framings=framings,
    )
    out = []
    while True:
        n = await iv.next_question()
        if n is None:
            break
        out.append(n)
    assert out == [
        ("Framing 1: data-first restatement", 0),
        ("Framing 2: decision-first restatement", 1),
        ("Framing 3: counterfactual restatement", 2),
    ]


@pytest.mark.asyncio
async def test_interviewer_stops_after_framings_exhausted():
    iv = Interviewer(
        client=None,
        persona=_persona(),
        question="Q?",
        memory=DialogueMemory(),
        framings=["only framing"],
    )
    first = await iv.next_question()
    assert first == ("only framing", 0)
    second = await iv.next_question()
    assert second is None  # exhausted


def test_question_analysis_parses_framings_and_keeps_three():
    plan = _parse_plan(
        {
            "complexity": "moderate",
            "complexity_score": 3,
            "recommended_personas": 3,
            "axes": ["demographics"],
            "must_have_perspectives": [],
            "sub_questions": [],
            "framings": [
                "Framing one",
                "Framing two",
                "  ",  # blank → dropped
                "Framing three",
            ],
            "rationale": "r",
        }
    )
    assert plan.framings == ["Framing one", "Framing two", "Framing three"]


def test_question_analysis_tolerates_missing_framings():
    plan = _parse_plan({"complexity": "moderate", "complexity_score": 3})
    assert plan.framings == []


def test_apply_edits_replaces_framings_when_edited():
    plan = PlanForReview(
        run_id="r",
        question="Q?",
        executive_intent="i",
        personas=[],
        sections=[],
        framings=["upstream A", "upstream B"],
    )
    edited = hitl.apply_edits(
        plan, PlanEdit(decision="approve", framings=["edited only"])
    )
    assert edited.framings == ["edited only"]


def test_apply_edits_keeps_upstream_framings_when_omitted():
    plan = PlanForReview(
        run_id="r",
        question="Q?",
        executive_intent="i",
        personas=[],
        sections=[],
        framings=["upstream A", "upstream B"],
    )
    edited = hitl.apply_edits(plan, PlanEdit(decision="approve"))
    assert edited.framings == ["upstream A", "upstream B"]

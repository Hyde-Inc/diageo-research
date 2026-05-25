"""Tests for the human-in-the-loop pause primitive."""
from __future__ import annotations

import asyncio

import pytest

from diageo_research import hitl
from diageo_research.models import OutlineSection, Persona, PlanEdit, PlanForReview


def _plan(run_id: str = "r1") -> PlanForReview:
    return PlanForReview(
        run_id=run_id,
        question="Q?",
        executive_intent="upstream intent",
        personas=[
            Persona(
                id="p1", name="Gen Z Lead", role="r1", lens="l1",
                description="d1", system_prompt="sp1", checklist=["c1"],
                section_assignments=["S1"],
            ),
            Persona(
                id="p2", name="Channel Lead", role="r2", lens="l2",
                description="d2", system_prompt="sp2", checklist=["c2"],
                section_assignments=["S2"],
            ),
        ],
        sections=[
            OutlineSection(heading="S1", intent="i1"),
            OutlineSection(heading="S2", intent="i2"),
        ],
    )


def test_apply_edits_overrides_only_supplied_fields():
    plan = _plan()
    new_personas = list(plan.personas) + [Persona(
        id="p3", name="Pricing Lead", role="r3", lens="l3",
        description="d3", system_prompt="sp3", checklist=[],
    )]
    edit = PlanEdit(decision="approve", personas=new_personas)
    out = hitl.apply_edits(plan, edit)
    # personas were replaced; intent + sections preserved verbatim from upstream
    assert len(out.personas) == 3
    assert out.executive_intent == "upstream intent"
    assert out.sections == plan.sections


def test_apply_edits_can_replace_intent_and_sections():
    plan = _plan()
    edit = PlanEdit(
        decision="approve",
        executive_intent="edited intent",
        sections=[OutlineSection(heading="ONLY")],
    )
    out = hitl.apply_edits(plan, edit)
    assert out.executive_intent == "edited intent"
    assert [s.heading for s in out.sections] == ["ONLY"]
    assert out.personas == plan.personas


@pytest.mark.asyncio
async def test_await_edits_resolves_when_submit_called():
    plan = _plan("r-async")

    async def submitter() -> None:
        # Wait until the orchestrator side has parked the run, then submit.
        for _ in range(100):
            if hitl.is_paused("r-async"):
                break
            await asyncio.sleep(0.01)
        assert hitl.get_plan("r-async") is not None
        accepted = hitl.submit_edit(
            "r-async",
            PlanEdit(decision="approve", executive_intent="from human"),
        )
        assert accepted

    submit_task = asyncio.create_task(submitter())
    edit = await hitl.await_edits("r-async", plan, timeout_s=2.0)
    await submit_task

    assert edit.decision == "approve"
    assert edit.executive_intent == "from human"
    # After resolution the run must no longer be parked.
    assert not hitl.is_paused("r-async")


@pytest.mark.asyncio
async def test_await_edits_times_out_to_abort():
    plan = _plan("r-timeout")
    edit = await hitl.await_edits("r-timeout", plan, timeout_s=0.05)
    assert edit.decision == "abort"
    assert not hitl.is_paused("r-timeout")


def test_submit_edit_returns_false_when_not_paused():
    assert hitl.submit_edit("never-paused", PlanEdit()) is False
    assert hitl.get_plan("never-paused") is None

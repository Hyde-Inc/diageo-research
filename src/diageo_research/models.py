"""Pydantic models shared across the pipeline."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


PersonaType = Literal["consumer", "expert"]


class Persona(BaseModel):
    id: str
    name: str
    role: str
    lens: str
    description: str
    system_prompt: str
    persona_type: PersonaType = "expert"
    checklist: list[str] = Field(default_factory=list)
    section_assignments: list[str] = Field(default_factory=list)


class Citation(BaseModel):
    cite_id: str
    source: Literal["browser", "duckdb"]
    url: str | None = None
    title: str | None = None
    sql: str | None = None
    snippet: str | None = None
    verified: bool | None = None
    verification_note: str | None = None


class DialogueTurn(BaseModel):
    turn_idx: int
    question: str
    answer: str
    citations: list[Citation] = Field(default_factory=list)
    queries: list[str] = Field(default_factory=list)
    done: bool = False  # set when answer contained the <<DONE>> sentinel


class Reaction(BaseModel):
    """A single persona's reaction to another persona's headline claim during
    the cross-persona challenge round (improvement #3)."""

    from_persona_id: str
    to_persona_id: str
    claim: str
    stance: Literal["agree", "disagree", "nuance"]
    body: str
    citations: list[Citation] = Field(default_factory=list)


class SubReport(BaseModel):
    persona_id: str
    persona_name: str
    markdown: str
    citations: list[Citation] = Field(default_factory=list)
    reactions: list[Reaction] = Field(default_factory=list)
    headline_claim: str | None = None


class OutlineSection(BaseModel):
    heading: str
    intent: str = ""


ComplexityLevel = Literal["narrow", "focused", "moderate", "broad", "open_ended"]


class PerspectiveSpec(BaseModel):
    """A short brief for ONE persona the question requires. The persona
    generator uses these as anchors so it can't drift off-brief."""

    persona_type: PersonaType
    anchor: str = Field(
        ..., description="One-phrase descriptor (e.g. 'Gen Z Latina, Houston, weekend tequila buyer')."
    )
    why: str = Field(
        ..., description="One sentence: why this question NEEDS this perspective."
    )


class QuestionPlan(BaseModel):
    """Output of the upfront question-analysis pass (improvement: scale +
    target the panel to the question)."""

    complexity: ComplexityLevel
    complexity_score: int = Field(..., ge=1, le=5)
    recommended_personas: int = Field(..., ge=2, le=8)
    axes: list[str] = Field(default_factory=list)
    must_have_perspectives: list[PerspectiveSpec] = Field(default_factory=list)
    sub_questions: list[str] = Field(default_factory=list)
    rationale: str = ""


class FinalReport(BaseModel):
    question: str
    outline: list[str]
    markdown: str
    citations: list[Citation] = Field(default_factory=list)


class PlanForReview(BaseModel):
    """The full editable plan exposed to a human reviewer at the HITL pause.

    Captures everything generated upstream of the parallel interviews so the
    user can edit the panel composition + outline before any analyst time
    is spent. The orchestrator applies any edits before resuming."""

    run_id: str
    question: str
    executive_intent: str = ""
    personas: list[Persona] = Field(default_factory=list)
    sections: list[OutlineSection] = Field(default_factory=list)


class PlanEdit(BaseModel):
    """Human-supplied edits to the plan. Any field omitted leaves the
    upstream value unchanged. `decision` controls whether to resume with the
    edits applied or abort the run before any interviews run."""

    decision: Literal["approve", "abort"] = "approve"
    executive_intent: str | None = None
    personas: list[Persona] | None = None
    sections: list[OutlineSection] | None = None


class RunState(BaseModel):
    run_id: str
    question: str
    status: Literal["pending", "running", "complete", "error"] = "pending"
    started_at: datetime = Field(default_factory=_utcnow)
    finished_at: datetime | None = None
    error: str | None = None


class SSEEvent(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    type: str
    run_id: str
    persona_id: str | None = None
    turn_idx: int | None = None
    data: dict[str, Any] = Field(default_factory=dict)
    ts: datetime = Field(default_factory=_utcnow)


class BrowserSnippet(BaseModel):
    cite_id: str
    url: str
    title: str
    text: str


class QueryResult(BaseModel):
    cite_id: str
    sql: str
    columns: list[str]
    rows: list[dict[str, Any]]
    truncated: bool = False
    error: str | None = None

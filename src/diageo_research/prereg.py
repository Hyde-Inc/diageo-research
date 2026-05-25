"""Pre-registration registry for studies.

A pre-registration is a signed contract written BEFORE any data run, locking
the question, the decision rule, the evidence thresholds, the falsifier
conditions, and the holdout reservation. The multiverse runner refuses to
start a study without a valid prereg; the synthesizer surfaces the contract
fields in the brief so a stakeholder can see the rule the answer is being
evaluated against.

This is a thin module: load YAML → Pydantic → write back. The point is the
contract, not the machinery.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, ValidationError


class EvidenceThresholds(BaseModel):
    """Quantitative thresholds the recommendation must meet to fire."""

    multiverse_agreement_min: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description=(
            "Minimum fraction of defensible specs that must agree on the "
            "lead recommendation."
        ),
    )
    backcasting_pass_min: int = Field(
        default=0,
        ge=0,
        description=(
            "Minimum number of historical pressure periods the framework "
            "must predict correctly. 0 disables backcasting gating."
        ),
    )
    effect_size_min: float | None = Field(
        default=None,
        description=(
            "Optional minimum effect size (e.g. percentage-point gap) the "
            "recommendation must clear. Units are domain-specific."
        ),
    )


class PreReg(BaseModel):
    """The signed pre-registration contract for one study.

    Written to `runs/study_<id>/prereg.yaml` before the multiverse runs. The
    signed_at + signed_by fields are deliberately required: an unsigned
    prereg is not a contract."""

    question: str = Field(..., min_length=1)
    decision_rule: str = Field(
        ...,
        min_length=1,
        description=(
            "Plain-language rule mapping evidence to action. Example: "
            "'Reallocate spend from X to Y if multiverse-robust EV gap > 5pp.'"
        ),
    )
    evidence_thresholds: EvidenceThresholds
    falsifier_conditions: list[str] = Field(
        default_factory=list,
        description=(
            "Observable conditions under which the recommendation would be "
            "wrong. Without this, the claim is a story, not a hypothesis."
        ),
    )
    holdout_reservation: str = Field(
        default="",
        description=(
            "Plain-language description of the data partition reserved for "
            "blind evaluation. Empty string allowed for v1; production "
            "should never accept empty."
        ),
    )
    signed_at: datetime
    signed_by: str = Field(..., min_length=1)
    notes: str = ""

    def summary_lines(self) -> list[str]:
        """Render the prereg as bullet lines for injection into briefs."""
        lines = [
            f"Question: {self.question}",
            f"Decision rule: {self.decision_rule}",
            (
                f"Multiverse agreement threshold: "
                f"{self.evidence_thresholds.multiverse_agreement_min:.0%}"
            ),
        ]
        if self.evidence_thresholds.backcasting_pass_min > 0:
            lines.append(
                f"Backcasting pass threshold: "
                f"{self.evidence_thresholds.backcasting_pass_min} periods"
            )
        if self.evidence_thresholds.effect_size_min is not None:
            lines.append(
                f"Effect-size floor: {self.evidence_thresholds.effect_size_min}"
            )
        if self.falsifier_conditions:
            lines.append("Falsifier conditions:")
            for f in self.falsifier_conditions:
                lines.append(f"  - {f}")
        if self.holdout_reservation:
            lines.append(f"Holdout reservation: {self.holdout_reservation}")
        lines.append(
            f"Signed by {self.signed_by} at "
            f"{self.signed_at.astimezone(timezone.utc).isoformat()}"
        )
        return lines


class PreregError(ValueError):
    """Raised when a prereg cannot be loaded or is missing required fields."""


def load_prereg(path: Path) -> PreReg:
    """Load + validate a prereg from YAML. Raises PreregError on any failure."""
    if not path.exists():
        raise PreregError(
            f"prereg.yaml not found at {path}. "
            "A study cannot start without a signed pre-registration."
        )
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        raise PreregError(f"prereg.yaml at {path} is not valid YAML: {e}") from e
    if not isinstance(raw, dict):
        raise PreregError(
            f"prereg.yaml at {path} must be a YAML mapping, got {type(raw).__name__}."
        )
    try:
        return PreReg.model_validate(raw)
    except ValidationError as ve:
        raise PreregError(
            f"prereg.yaml at {path} failed validation:\n{ve}"
        ) from ve


def write_prereg(path: Path, prereg: PreReg) -> None:
    """Persist a PreReg to YAML."""
    payload: dict[str, Any] = prereg.model_dump(mode="json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(payload, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


def prereg_to_markdown(prereg: PreReg) -> str:
    """Render the prereg as a markdown block for stage artifacts and briefs."""
    body = ["# Pre-registration (signed before any data run)", ""]
    for line in prereg.summary_lines():
        if line.startswith("  - "):
            body.append(line)
        elif ":" in line and not line.startswith("Falsifier"):
            key, _, value = line.partition(":")
            body.append(f"- **{key.strip()}:** {value.strip()}")
        elif line.startswith("Falsifier conditions"):
            body.append("- **Falsifier conditions:**")
        else:
            body.append(f"- {line}")
    if prereg.notes:
        body.append("")
        body.append("> " + prereg.notes.replace("\n", "\n> "))
    return "\n".join(body)

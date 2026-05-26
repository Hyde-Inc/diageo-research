"""Natural-language revisions to an in-flight multiverse study spec.

The workbench plan chat posts plain instructions ("drop the colab taxonomy",
"focus on tequila + Casual Unwind"). We apply a small, deterministic rule
engine so the demo can show a real spec diff and optionally re-materialize
one cell as proof without re-running the full grid.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .multiverse import (
    StudySpec,
    expand_grid,
    load_spec,
    read_study,
    rerun_study_cell,
    write_study,
)

logger = logging.getLogger(__name__)


@dataclass
class PlanChange:
    path: str
    before: Any
    after: Any
    summary: str


@dataclass
class PlanRevision:
    instruction: str
    changes: list[PlanChange] = field(default_factory=list)
    spec_before: dict[str, Any] = field(default_factory=dict)
    spec_after: dict[str, Any] = field(default_factory=dict)
    diff_lines: list[str] = field(default_factory=list)
    queued_cell_id: str | None = None
    queued_run_id: str | None = None


def load_study_spec(study_id: str) -> StudySpec:
    study = read_study(study_id)
    if study is None:
        raise FileNotFoundError(f"No such study: {study_id}")
    path = Path(study.spec_path)
    if not path.exists():
        raise FileNotFoundError(f"No spec_grid.yaml for study {study_id}")
    return load_spec(path)


def save_study_spec(study_id: str, spec: StudySpec) -> Path:
    study = read_study(study_id)
    if study is None:
        raise FileNotFoundError(f"No such study: {study_id}")
    path = Path(study.spec_path)
    path.write_text(
        yaml.safe_dump(spec.model_dump(mode="json"), sort_keys=False),
        encoding="utf-8",
    )
    return path


def apply_plan_instruction(spec: StudySpec, instruction: str) -> tuple[StudySpec, list[PlanChange]]:
    """Apply deterministic NL patches. Returns updated spec + human summaries."""
    text = instruction.strip().lower()
    if not text:
        raise ValueError("Instruction is empty.")
    updated = spec.model_copy(deep=True)
    changes: list[PlanChange] = []

    if re.search(r"\bdrop\b.*\bcolab\b", text) or "drop colab" in text:
        for ax in updated.axes:
            if ax.name != "taxonomy":
                continue
            before_vals = [v.id for v in ax.values]
            ax.values = [v for v in ax.values if v.id != "colab"]
            if len(ax.values) < len(before_vals):
                changes.append(
                    PlanChange(
                        path="axes.taxonomy.values",
                        before=before_vals,
                        after=[v.id for v in ax.values],
                        summary="Removed CoLab occasion taxonomy from the grid.",
                    )
                )
            break

    if "tequila" in text:
        focus = "US tequila"
        if "casual unwind" in text or "casual" in text:
            focus += " · Casual Unwind occasion"
        if updated.question and focus.lower() not in updated.question.lower():
            before_q = updated.question
            updated.question = (
                f"{before_q.rstrip()} Focus the multiverse on {focus}."
            )
            changes.append(
                PlanChange(
                    path="question",
                    before=before_q,
                    after=updated.question,
                    summary=f"Narrowed the study question toward {focus}.",
                )
            )

    if "casual unwind" in text and not any(c.path == "question" for c in changes):
        snippet = "Casual Unwind"
        if snippet.lower() not in updated.question.lower():
            before_q = updated.question
            updated.question = f"{before_q.rstrip()} Prioritise the {snippet} occasion."
            changes.append(
                PlanChange(
                    path="question",
                    before=before_q,
                    after=updated.question,
                    summary=f"Prioritised the {snippet} occasion in the study question.",
                )
            )

    if not changes:
        changes.append(
            PlanChange(
                path="notes",
                before=None,
                after=instruction,
                summary=(
                    "Recorded your instruction for the next full re-run "
                    "(no automatic spec fields matched this phrasing)."
                ),
            )
        )
    return updated, changes


def revision_from_instruction(study_id: str, instruction: str) -> PlanRevision:
    before_spec = load_study_spec(study_id)
    before_dict = before_spec.model_dump(mode="json")
    after_spec, changes = apply_plan_instruction(before_spec, instruction)
    after_dict = after_spec.model_dump(mode="json")
    diff_lines = [c.summary for c in changes]
    return PlanRevision(
        instruction=instruction,
        changes=changes,
        spec_before=before_dict,
        spec_after=after_dict,
        diff_lines=diff_lines,
    )


def persist_revision(study_id: str, revision: PlanRevision) -> None:
    after_spec = StudySpec.model_validate(revision.spec_after)
    save_study_spec(study_id, after_spec)
    study = read_study(study_id)
    if study is None:
        return
    study.question = after_spec.question
    write_study(study)


def pick_proof_cell(study_id: str, spec: StudySpec) -> tuple[str, str]:
    """Choose one cell to re-materialize after a plan change."""
    study = read_study(study_id)
    if study is None:
        raise FileNotFoundError(f"No such study: {study_id}")
    grid = expand_grid(spec)
    grid_ids = {c.id for c in grid}
    # Prefer a cell that still exists in the new grid and is incomplete.
    for cell in study.cells:
        if cell.id in grid_ids and cell.status != "complete":
            return cell.id, cell.run_id
    for cell in study.cells:
        if cell.id in grid_ids:
            return cell.id, cell.run_id
    if grid:
        c = grid[0]
        run_id = f"{study_id}_{c.id}"
        return c.id, run_id
    raise ValueError("Study has no cells to queue.")


async def rerun_single_cell(study_id: str, cell_id: str) -> str:
    """Re-run one multiverse cell under the current on-disk spec."""
    return await rerun_study_cell(study_id, cell_id)

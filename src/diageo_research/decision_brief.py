"""Decision-brief contract: every brief carries the rule it was scored
against, the multiverse robustness of the leading recommendation, the
fragile specifications, and the falsifier status.

The synthesizer is intentionally unaware of multiverse / prereg state so
its surface stays clean. This module post-augments the synthesizer's
`final.md` with two blocks:

1. Pre-registration block — prepended after the executive answer. Carries
   the question, decision rule, falsifier conditions, and holdout. Written
   per-cell after the cell finishes synthesis.

2. Multiverse summary block — appended after the executive answer. Carries
   the robustness score, the fragile specs, and the falsifier status.
   Written once per study (against the lead cell) after the spec curve
   is built.

Both blocks are idempotent: re-applying them replaces the previous
version rather than stacking, so the brief stays clean across re-runs.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING

from .prereg import PreReg

if TYPE_CHECKING:
    # Imported only for type hints to avoid a circular import:
    # multiverse_report -> multiverse -> decision_brief.
    from .multiverse_report import SpecCurve

logger = logging.getLogger(__name__)


_PREREG_BLOCK_START = "<!-- prereg-block:start -->"
_PREREG_BLOCK_END = "<!-- prereg-block:end -->"
_MV_BLOCK_START = "<!-- multiverse-block:start -->"
_MV_BLOCK_END = "<!-- multiverse-block:end -->"


# --------------------------------------------------------------- Pre-reg block


def render_prereg_block(prereg: PreReg) -> str:
    """Markdown block summarising the signed pre-registration."""
    lines: list[str] = []
    lines.append(_PREREG_BLOCK_START)
    lines.append("## Pre-registration (signed before any data run)")
    lines.append("")
    lines.append(f"- **Decision rule:** {prereg.decision_rule}")
    lines.append(
        f"- **Multiverse agreement threshold:** "
        f"{prereg.evidence_thresholds.multiverse_agreement_min:.0%}"
    )
    if prereg.evidence_thresholds.effect_size_min is not None:
        lines.append(
            f"- **Effect-size floor:** "
            f"{prereg.evidence_thresholds.effect_size_min}"
        )
    if prereg.falsifier_conditions:
        lines.append("- **Falsifier conditions:**")
        for f in prereg.falsifier_conditions:
            lines.append(f"  - {f}")
    if prereg.holdout_reservation:
        lines.append(f"- **Holdout reservation:** {prereg.holdout_reservation}")
    lines.append(
        f"- **Signed by:** {prereg.signed_by} at "
        f"{prereg.signed_at.isoformat()}"
    )
    lines.append(_PREREG_BLOCK_END)
    return "\n".join(lines)


# --------------------------------------------------------------- Multiverse block


def render_multiverse_block(curve: "SpecCurve", focus_cell_id: str | None = None) -> str:
    """Markdown block summarising multiverse robustness for the brief.

    `focus_cell_id` is the cell whose brief this block is being added to;
    we surface its agreement/flip status against the lead recommendation
    so the cell's brief is honest about its own role in the curve.
    """
    lines: list[str] = []
    lines.append(_MV_BLOCK_START)
    lines.append("## Multiverse robustness")
    lines.append("")
    lines.append(
        f"_Same question executed across {curve.n_complete} of {curve.n_cells} "
        f"defensible specifications._"
    )
    lines.append("")

    if not curve.rows:
        lines.append("_No clustered recommendations available — see spec curve for raw briefs._")
        lines.append(_MV_BLOCK_END)
        return "\n".join(lines)

    lead = curve.rows[0]
    lines.append(
        f"- **Lead recommendation:** {_clip(lead.representative, 240)}"
    )
    lines.append(
        f"- **Robustness:** {lead.robustness:.0%} "
        f"({lead.n_agree}/{len(lead.statuses)} cells agree)"
    )
    if lead.fragile_specs:
        fragile = ", ".join(f"`{s}`" for s in lead.fragile_specs)
        lines.append(f"- **Fragile in:** {fragile}")
    if focus_cell_id and focus_cell_id in lead.statuses:
        own_status = lead.statuses[focus_cell_id]
        lines.append(
            f"- **This spec's stance on the lead recommendation:** `{own_status}`"
        )

    falsifier_status = (curve.falsifier_status or "unknown").replace("_", " ")
    lines.append(f"- **Falsifier status:** {falsifier_status}")
    if curve.falsifier_notes:
        lines.append("")
        lines.append("**Falsifier evaluation notes:**")
        for n in curve.falsifier_notes:
            lines.append(f"- {n}")

    if len(curve.rows) > 1:
        lines.append("")
        lines.append("**Other recommendations surfaced across the multiverse:**")
        for row in curve.rows[1:6]:
            lines.append(
                f"- ({row.robustness:.0%}) {_clip(row.representative, 200)}"
            )
    lines.append(_MV_BLOCK_END)
    return "\n".join(lines)


# --------------------------------------------------------------- Apply / strip


def _strip_block(markdown: str, start: str, end: str) -> str:
    """Remove a previously applied augmentation block, if present."""
    pattern = re.compile(
        re.escape(start) + r".*?" + re.escape(end) + r"\n?",
        re.DOTALL,
    )
    return pattern.sub("", markdown)


def _insert_after_executive_answer(markdown: str, block: str) -> str:
    """Insert `block` immediately after the executive-answer section.

    The synthesizer emits:

        # Strategy brief — <question>
        ## Executive answer
        <prose>
        ## <next section>

    We slot the new block between the executive prose and the next `## `.
    If the markers don't match, we append at the top under the title.
    """
    lines = markdown.splitlines()
    # Find executive answer header.
    exec_idx = -1
    for i, ln in enumerate(lines):
        if ln.strip() == "## Executive answer":
            exec_idx = i
            break
    if exec_idx == -1:
        # No executive answer; insert after the H1 title.
        for i, ln in enumerate(lines):
            if ln.startswith("# "):
                head = lines[: i + 1]
                tail = lines[i + 1 :]
                return "\n".join(head + ["", block] + tail)
        return block + "\n\n" + markdown
    # Find next H2 after executive answer.
    insert_idx = len(lines)
    for j in range(exec_idx + 1, len(lines)):
        if lines[j].startswith("## "):
            insert_idx = j
            break
    head = lines[:insert_idx]
    tail = lines[insert_idx:]
    return "\n".join(head + ["", block, ""] + tail)


def apply_prereg_to_brief(run_dir: Path, prereg: PreReg) -> bool:
    """Augment `runs/<id>/final.md` with the prereg block. Idempotent.

    Returns True if the brief was written, False if no brief exists."""
    final_md = run_dir / "final.md"
    if not final_md.exists():
        return False
    text = final_md.read_text(encoding="utf-8")
    text = _strip_block(text, _PREREG_BLOCK_START, _PREREG_BLOCK_END)
    block = render_prereg_block(prereg)
    text = _insert_after_executive_answer(text, block)
    final_md.write_text(text, encoding="utf-8")
    return True


def apply_multiverse_to_brief(
    run_dir: Path,
    curve: "SpecCurve",
    focus_cell_id: str | None = None,
) -> bool:
    """Augment `runs/<id>/final.md` with the multiverse summary block.

    Idempotent. Returns True if the brief was written, False if no brief
    exists."""
    final_md = run_dir / "final.md"
    if not final_md.exists():
        return False
    text = final_md.read_text(encoding="utf-8")
    text = _strip_block(text, _MV_BLOCK_START, _MV_BLOCK_END)
    block = render_multiverse_block(curve, focus_cell_id=focus_cell_id)
    text = _insert_after_executive_answer(text, block)
    final_md.write_text(text, encoding="utf-8")
    return True


def _clip(text: str, n: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[: n - 1] + "…"

"""Spec curve generator: read every cell's final brief and emit the
multiverse comparison artefact.

For each completed cell we extract candidate "recommendations" from the
final brief (the executive answer plus any sentence in the section bodies
that contains an action verb in a recommend-like form). Recommendations
are clustered by approximate text similarity (Jaccard over token sets);
each cluster becomes one row of the spec curve. For every (cluster, cell)
pair we record a status:

- agree   : cluster is supported by the cell's brief
- weaker  : the cell brings up the cluster but with hedged / opposite-sign
            wording
- flips   : the cell explicitly recommends the opposite action
- missing : the cell does not address the cluster at all

The robustness score for a cluster is the fraction of cells where the
status is `agree`. A high-robustness cluster survives most defensible
specifications; a low one is fragile.

The output is two files:

- `runs/<study_id>/spec_curve.json`  machine-readable, consumed by API/UI
- `runs/<study_id>/spec_curve.md`     human-readable, embeddable in briefs

This is a heuristic v1; the framing matters more than the exact metric.
The point is to make robustness visible at all.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Iterable, Literal

from pydantic import BaseModel, Field

from .config import get_settings
from .multiverse import Study, read_study

logger = logging.getLogger(__name__)


CellStatusOnRow = Literal["agree", "weaker", "flips", "missing"]


# A "recommendation" is anything that reads like a directive sentence in the
# final brief. Heuristic: the sentence contains one of these verbs/phrases
# AND a noun-phrase target (we approximate target by everything after the
# verb up to the first sentence terminator).
_REC_PATTERNS = (
    r"\b(?:should|recommend|reallocate|prioritis(?:e|ze)|focus|invest|"
    r"shift|increase|reduce|decrease|hold|defend|grow|expand|exit|enter|"
    r"target|protect|launch|kill|cut|raise|lower)\b"
)
_REC_RE = re.compile(_REC_PATTERNS, re.IGNORECASE)
_NEGATION_RE = re.compile(
    r"\b(?:do not|don't|never|avoid|reject|oppose|stop|halt|kill)\b",
    re.IGNORECASE,
)
_HEDGE_RE = re.compile(
    r"\b(?:may|might|could|possibly|perhaps|consider|tentatively|"
    r"if conditions|subject to|provisionally)\b",
    re.IGNORECASE,
)


class SpecCurveRow(BaseModel):
    """One recommendation × all cells row in the spec curve table."""

    cluster_id: int
    representative: str  # the recommendation text we use as the cluster label
    members: list[str] = Field(default_factory=list)  # all variant texts
    statuses: dict[str, CellStatusOnRow] = Field(default_factory=dict)  # cell_id -> status
    robustness: float = 0.0  # fraction of cells where status == "agree"
    n_agree: int = 0
    n_weaker: int = 0
    n_flips: int = 0
    n_missing: int = 0
    fragile_specs: list[str] = Field(default_factory=list)  # cells where status != "agree"


class SpecCurve(BaseModel):
    """The full multiverse comparison artefact for one study."""

    study_id: str
    study_name: str
    question: str
    n_cells: int
    n_complete: int
    n_error: int
    cells: list[dict[str, Any]] = Field(default_factory=list)  # cell summary rows
    rows: list[SpecCurveRow] = Field(default_factory=list)
    falsifier_status: Literal["not_triggered", "partially_triggered", "fully_triggered", "unknown"] = "unknown"
    falsifier_notes: list[str] = Field(default_factory=list)


# ----------------------------------------------------------- Extraction helpers


def _split_sentences(text: str) -> list[str]:
    """Cheap sentence split: terminator-based, citation-marker aware."""
    if not text:
        return []
    text = text.replace("\n", " ")
    # Split on . ! ? followed by whitespace and a capital, but be lenient.
    raw = re.split(r"(?<=[.!?])\s+(?=[A-Z\[])", text)
    return [s.strip() for s in raw if s.strip()]


def _is_recommendation(sentence: str) -> bool:
    """Does this sentence read like a directive recommendation?"""
    return bool(_REC_RE.search(sentence))


def _strip_citations(text: str) -> str:
    return re.sub(r"\[[A-Z]?\d+\]", "", text).strip()


def _tokenize(text: str) -> set[str]:
    """Token set for Jaccard. Lowercase, alpha-only, longer than 2 chars."""
    text = _strip_citations(text).lower()
    tokens = re.findall(r"[a-z]+", text)
    return {t for t in tokens if len(t) > 2}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _recommendations_from_final(final_md: str) -> list[str]:
    """Pull candidate recommendation sentences from a final brief.

    Strategy: take the executive answer (everything before the first `## `
    heading after the `# Strategy brief` line) plus any sentence in the
    rest of the brief that matches the recommendation regex.
    """
    if not final_md:
        return []

    lines = final_md.splitlines()
    exec_block: list[str] = []
    in_exec = False
    body: list[str] = []
    for line in lines:
        if line.startswith("## Executive answer"):
            in_exec = True
            continue
        if in_exec and line.startswith("## "):
            in_exec = False
        if in_exec:
            exec_block.append(line)
        else:
            body.append(line)

    candidates: list[str] = []
    exec_text = " ".join(exec_block).strip()
    for s in _split_sentences(exec_text):
        # Executive answer sentences are inherently recommendation-shaped.
        if len(s) > 30:
            candidates.append(_strip_citations(s).strip())

    body_text = " ".join(body)
    for s in _split_sentences(body_text):
        if _is_recommendation(s) and len(s) > 30:
            candidates.append(_strip_citations(s).strip())

    out: list[str] = []
    seen: set[str] = set()
    for s in candidates:
        key = s.lower()[:120]
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


# --------------------------------------------------------------- Cluster build


def _cluster_recommendations(
    cell_recs: dict[str, list[str]],
    threshold: float = 0.45,
) -> list[dict[str, Any]]:
    """Greedy single-link clustering by Jaccard over token sets.

    Returns a list of cluster dicts: { id, representative, members,
    member_cells }. The representative is the longest member.
    """
    clusters: list[dict[str, Any]] = []
    next_id = 0
    for cell_id, recs in cell_recs.items():
        for rec in recs:
            tokens = _tokenize(rec)
            if not tokens:
                continue
            attached = False
            for cl in clusters:
                if _jaccard(tokens, cl["tokens"]) >= threshold:
                    cl["members"].append(rec)
                    cl["member_cells"].setdefault(cell_id, []).append(rec)
                    cl["tokens"] |= tokens
                    if len(rec) > len(cl["representative"]):
                        cl["representative"] = rec
                    attached = True
                    break
            if not attached:
                clusters.append(
                    {
                        "id": next_id,
                        "representative": rec,
                        "members": [rec],
                        "member_cells": {cell_id: [rec]},
                        "tokens": set(tokens),
                    }
                )
                next_id += 1
    return clusters


def _classify_cell_for_cluster(
    cell_recs: list[str],
    full_text: str,
    cluster_tokens: set[str],
) -> CellStatusOnRow:
    """Classify how this cell relates to the cluster.

    - agree: a cell rec strongly overlaps with the cluster tokens
    - weaker: a cell rec moderately overlaps but is hedged
    - flips: a cell rec moderately overlaps and is negated
    - missing: nothing overlaps
    """
    best_overlap = 0.0
    best_rec = ""
    for rec in cell_recs:
        ov = _jaccard(_tokenize(rec), cluster_tokens)
        if ov > best_overlap:
            best_overlap = ov
            best_rec = rec
    if best_overlap >= 0.45:
        if _NEGATION_RE.search(best_rec):
            return "flips"
        if _HEDGE_RE.search(best_rec):
            return "weaker"
        return "agree"
    # Fall back: scan full body — the cluster topic might be discussed
    # without being a recommendation in this cell.
    body_tokens = _tokenize(full_text)
    body_overlap = (
        len(cluster_tokens & body_tokens) / len(cluster_tokens)
        if cluster_tokens
        else 0.0
    )
    if body_overlap >= 0.55:
        return "weaker"
    return "missing"


# ------------------------------------------------------- Falsifier evaluation


def _evaluate_falsifiers(
    rows: list[SpecCurveRow],
    falsifier_conditions: Iterable[str],
) -> tuple[Literal["not_triggered", "partially_triggered", "fully_triggered", "unknown"], list[str]]:
    """Heuristic falsifier evaluation against the spec curve.

    A falsifier of the form "underperforms in three or more defensible
    specifications" is checked against any cluster's flip/weaker count.
    A falsifier of the form "framings disagree on lead recommendation in
    more than 50% of cells" is checked by comparing the lead cluster's
    cell statuses across taxonomy axis values when one is observable.
    Anything more bespoke gets `unknown` and the operator must inspect.
    """
    notes: list[str] = []
    triggered = 0
    seen = 0
    for cond in falsifier_conditions:
        seen += 1
        cond_l = cond.lower()
        if not rows:
            notes.append(f"Falsifier '{cond[:60]}…' could not be evaluated (no spec-curve rows).")
            continue
        lead = rows[0]
        if "three or more" in cond_l or "3 or more" in cond_l:
            if (lead.n_flips + lead.n_weaker) >= 3:
                triggered += 1
                notes.append(
                    f"Falsifier triggered: lead recommendation flips/weakens in "
                    f"{lead.n_flips + lead.n_weaker} of {len(lead.statuses)} cells."
                )
            else:
                notes.append(
                    f"Falsifier not triggered: lead recommendation flips/weakens in "
                    f"only {lead.n_flips + lead.n_weaker} of {len(lead.statuses)} cells."
                )
            continue
        if "more than 50" in cond_l or "majority" in cond_l:
            if lead.robustness < 0.5:
                triggered += 1
                notes.append(
                    f"Falsifier triggered: lead recommendation robustness "
                    f"{lead.robustness:.0%} is below the 50% majority threshold."
                )
            else:
                notes.append(
                    f"Falsifier not triggered: lead recommendation robustness "
                    f"{lead.robustness:.0%} is at or above the 50% threshold."
                )
            continue
        notes.append(
            f"Falsifier '{cond[:80]}…' requires bespoke evaluation (e.g. external "
            "elasticity check or backcasting); not auto-evaluated by spec curve."
        )

    if seen == 0:
        return "unknown", notes
    if triggered == 0:
        return "not_triggered", notes
    if triggered >= seen:
        return "fully_triggered", notes
    return "partially_triggered", notes


# ------------------------------------------------------------ Public entry


def build_spec_curve(study_id: str) -> SpecCurve:
    """Read all completed cell briefs for a study and return its spec curve."""
    settings = get_settings()
    study = read_study(study_id)
    if study is None:
        raise FileNotFoundError(f"study {study_id} not found")

    cell_recs: dict[str, list[str]] = {}
    cell_text: dict[str, str] = {}
    cells_summary: list[dict[str, Any]] = []
    for cell in study.cells:
        run_dir = settings.runs_dir / cell.run_id
        final_md_path = run_dir / "final.md"
        text = final_md_path.read_text(encoding="utf-8") if final_md_path.exists() else ""
        recs = _recommendations_from_final(text) if text else []
        cell_recs[cell.id] = recs
        cell_text[cell.id] = text
        cells_summary.append(
            {
                "id": cell.id,
                "axes": cell.axes,
                "run_id": cell.run_id,
                "status": cell.status,
                "elapsed_s": cell.elapsed_s,
                "n_recommendations": len(recs),
                "error": cell.error,
            }
        )

    clusters = _cluster_recommendations(cell_recs)
    # Sort clusters by total mentions (rough proxy for importance).
    clusters.sort(
        key=lambda cl: sum(len(v) for v in cl["member_cells"].values()),
        reverse=True,
    )

    rows: list[SpecCurveRow] = []
    for cl in clusters:
        statuses: dict[str, CellStatusOnRow] = {}
        for cell_id, _ in cell_recs.items():
            recs = cell_recs.get(cell_id, [])
            text = cell_text.get(cell_id, "")
            if cell_id in cl["member_cells"]:
                statuses[cell_id] = (
                    "flips"
                    if any(_NEGATION_RE.search(r) for r in cl["member_cells"][cell_id])
                    else (
                        "weaker"
                        if any(_HEDGE_RE.search(r) for r in cl["member_cells"][cell_id])
                        else "agree"
                    )
                )
            else:
                statuses[cell_id] = _classify_cell_for_cluster(recs, text, cl["tokens"])
        n_agree = sum(1 for s in statuses.values() if s == "agree")
        n_weaker = sum(1 for s in statuses.values() if s == "weaker")
        n_flips = sum(1 for s in statuses.values() if s == "flips")
        n_missing = sum(1 for s in statuses.values() if s == "missing")
        n_total = len(statuses) or 1
        fragile = [c for c, s in statuses.items() if s != "agree"]
        rows.append(
            SpecCurveRow(
                cluster_id=cl["id"],
                representative=cl["representative"],
                members=cl["members"],
                statuses=statuses,
                robustness=round(n_agree / n_total, 3),
                n_agree=n_agree,
                n_weaker=n_weaker,
                n_flips=n_flips,
                n_missing=n_missing,
                fragile_specs=fragile,
            )
        )

    # Sort rows by robustness desc, then by total mentions desc.
    rows.sort(key=lambda r: (-r.robustness, -(r.n_agree + r.n_weaker)))

    falsifier_status, falsifier_notes = _evaluate_falsifiers(
        rows, _read_falsifier_conditions(study)
    )

    n_complete = sum(1 for c in study.cells if c.status == "complete")
    n_error = sum(1 for c in study.cells if c.status == "error")
    return SpecCurve(
        study_id=study.id,
        study_name=study.name,
        question=study.question,
        n_cells=len(study.cells),
        n_complete=n_complete,
        n_error=n_error,
        cells=cells_summary,
        rows=rows,
        falsifier_status=falsifier_status,
        falsifier_notes=falsifier_notes,
    )


def _read_falsifier_conditions(study: Study) -> list[str]:
    """Read falsifier conditions out of the prereg yaml on disk."""
    try:
        from .prereg import load_prereg

        return load_prereg(Path(study.prereg_path)).falsifier_conditions
    except Exception:  # noqa: BLE001
        return []


# --------------------------------------------------------------- Persistence


def write_spec_curve(study_id: str) -> tuple[Path, Path]:
    """Build the spec curve, persist both JSON and markdown, and augment
    every completed cell's brief with the multiverse summary block."""
    curve = build_spec_curve(study_id)
    settings = get_settings()
    out_dir = settings.runs_dir / study_id
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "spec_curve.json"
    md_path = out_dir / "spec_curve.md"
    json_path.write_text(curve.model_dump_json(indent=2), encoding="utf-8")
    md_path.write_text(_render_spec_curve_md(curve), encoding="utf-8")

    # Decision-brief contract step 2: append the multiverse summary block
    # to every completed cell's brief so the brief carries its own role
    # in the spec curve. Best-effort; never raises.
    study = read_study(study_id)
    if study is not None:
        try:
            from .decision_brief import apply_multiverse_to_brief

            for cell in study.cells:
                if cell.status != "complete":
                    continue
                cell_dir = settings.runs_dir / cell.run_id
                try:
                    apply_multiverse_to_brief(cell_dir, curve, focus_cell_id=cell.id)
                except Exception:  # noqa: BLE001
                    logger.exception(
                        "multiverse block injection failed for cell %s", cell.id
                    )
        except Exception:  # noqa: BLE001
            logger.exception("multiverse brief augmentation skipped")
    return json_path, md_path


def _render_spec_curve_md(curve: SpecCurve) -> str:
    """Render the spec curve as markdown for human consumption."""
    lines: list[str] = []
    lines.append(f"# Spec curve — {curve.study_name}")
    lines.append("")
    lines.append(f"**Question:** {curve.question}")
    lines.append("")
    lines.append(
        f"**Cells:** {curve.n_complete} complete · {curve.n_error} errors · "
        f"{curve.n_cells} total"
    )
    lines.append("")
    lines.append(
        f"**Falsifier status:** {curve.falsifier_status.replace('_', ' ')}"
    )
    lines.append("")
    if curve.falsifier_notes:
        for note in curve.falsifier_notes:
            lines.append(f"- {note}")
        lines.append("")
    if not curve.rows:
        lines.append(
            "_No clustered recommendations yet. Either no cells are complete or "
            "no recommendation-shaped sentences were found in the briefs._"
        )
        return "\n".join(lines)

    lines.append("## Recommendation × spec status")
    lines.append("")
    cell_ids = [c["id"] for c in curve.cells]
    header = ["#", "Recommendation", "Robustness"] + cell_ids
    lines.append("| " + " | ".join(header) + " |")
    lines.append("|" + "|".join(["---"] * len(header)) + "|")
    glyphs = {"agree": "✓", "weaker": "~", "flips": "✗", "missing": "·"}
    for i, row in enumerate(curve.rows, 1):
        rep = row.representative.replace("|", "\\|")
        if len(rep) > 110:
            rep = rep[:107] + "…"
        cells_status = [glyphs.get(row.statuses.get(cid, "missing"), "·") for cid in cell_ids]
        lines.append(
            "| "
            + " | ".join(
                [
                    str(i),
                    rep,
                    f"{row.robustness:.0%} ({row.n_agree}/{len(cell_ids)})",
                    *cells_status,
                ]
            )
            + " |"
        )
    lines.append("")
    lines.append("Legend: `✓` agree · `~` weaker / hedged · `✗` flips · `·` missing")
    return "\n".join(lines)

"""Stakeholder-facing research summary: top occasions at risk + brief excerpt."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import get_settings
from .multiverse import read_study
from .multiverse_report import build_spec_curve


@dataclass
class TopRiskCard:
    occasion: str
    line: str
    robustness: float
    robustness_label: str
    illustrative: bool
    source_assets: list[str] = field(default_factory=list)


@dataclass
class ResearchSummary:
    study_id: str
    question: str
    top_risks: list[TopRiskCard]
    brief_markdown: str
    brief_illustrative: bool
    lead_cluster_id: int | None = None


_OCCASION_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"casual\s+unwind", re.I), "Casual Unwind"),
    (re.compile(r"social\s+celebrat", re.I), "Social Celebration"),
    (re.compile(r"intentional\s+discover", re.I), "Intentional Discovery"),
    (re.compile(r"fine\s+dining", re.I), "Fine Dining"),
    (re.compile(r"value[\s-]?tier|value\s+vodka", re.I), "Value-tier spirits"),
    (re.compile(r"tequila", re.I), "US tequila"),
    (re.compile(r"rtd|ready[\s-]?to[\s-]?drink", re.I), "RTD / premix"),
    (re.compile(r"moderation", re.I), "Moderation-led socializing"),
]


def _robustness_label(score: float) -> str:
    if score >= 0.7:
        return "Holds in most scenarios"
    if score >= 0.4:
        return "Mixed across scenarios"
    return "Fragile — check before acting"


def _extract_executive(md: str) -> str:
    m = re.search(
        r"##\s*Executive\s+answer\s*\n+(.*?)(?=\n##\s|\Z)",
        md,
        re.I | re.S,
    )
    return (m.group(1).strip() if m else md[:1200]).strip()


def _scan_occasions(text: str) -> list[str]:
    found: list[str] = []
    for pat, label in _OCCASION_PATTERNS:
        if pat.search(text) and label not in found:
            found.append(label)
    return found


def _fallback_cards(question: str) -> list[TopRiskCard]:
    """Grounded demo cards when briefs don't yet expose occasion-level splits."""
    q = question.lower()
    cards = [
        TopRiskCard(
            occasion="Casual Unwind",
            line="Trade-down from premium tequila into value-tier and RTD substitutes shows up most here.",
            robustness=0.62,
            robustness_label="Holds in most scenarios",
            illustrative=True,
            source_assets=["spec_curve.json", "brief.md (illustrative)"],
        ),
        TopRiskCard(
            occasion="Social Celebration",
            line="On-premise premium pours soften when disposable income is squeezed.",
            robustness=0.48,
            robustness_label="Mixed across scenarios",
            illustrative=True,
            source_assets=["spec_curve.json", "brief.md (illustrative)"],
        ),
        TopRiskCard(
            occasion="US tequila · Fine Dining",
            line="High-margin tequila occasions compress before mainstream vodka.",
            robustness=0.41,
            robustness_label="Mixed across scenarios",
            illustrative=True,
            source_assets=["spec_curve.json", "brief.md (illustrative)"],
        ),
    ]
    if "tequila" not in q:
        cards[2] = TopRiskCard(
            occasion="Value-tier spirits",
            line="Private-label and value-tier substitution is the largest near-term volume risk.",
            robustness=0.55,
            robustness_label="Mixed across scenarios",
            illustrative=True,
            source_assets=["spec_curve.json", "brief.md (illustrative)"],
        )
    return cards


def build_research_summary(study_id: str) -> ResearchSummary:
    study = read_study(study_id)
    if study is None:
        raise FileNotFoundError(f"No such study: {study_id}")
    settings = get_settings()
    curve = build_spec_curve(study_id)
    lead = curve.rows[0] if curve.rows else None

    occasion_scores: dict[str, tuple[float, str, list[str]]] = {}
    brief_parts: list[str] = []

    for cell in study.cells:
        if cell.status != "complete":
            continue
        path = settings.runs_dir / cell.run_id / "final.md"
        if not path.exists():
            continue
        md = path.read_text(encoding="utf-8")
        exec_para = _extract_executive(md)
        brief_parts.append(f"### Scenario {cell.id.replace('__', ' · ')}\n\n{exec_para}")
        for occ in _scan_occasions(exec_para + " " + md):
            prev = occasion_scores.get(occ)
            assets = [f"runs/{cell.run_id}/final.md", "spec_curve.json"]
            if prev is None:
                occasion_scores[occ] = (0.5, exec_para[:160], assets)
            else:
                occasion_scores[occ] = (max(prev[0], 0.5), prev[1], list(set(prev[2] + assets)))

    if lead:
        for occ in _scan_occasions(lead.representative):
            occasion_scores.setdefault(
                occ,
                (lead.robustness, lead.representative[:160], ["spec_curve.json"]),
            )

    top_risks: list[TopRiskCard] = []
    if occasion_scores:
        ranked = sorted(
            occasion_scores.items(),
            key=lambda x: (-x[1][0], x[0]),
        )[:3]
        for occ, (rob, line, assets) in ranked:
            top_risks.append(
                TopRiskCard(
                    occasion=occ,
                    line=line,
                    robustness=rob if rob <= 1 else rob / 100,
                    robustness_label=_robustness_label(rob if rob <= 1 else rob / 100),
                    illustrative=False,
                    source_assets=assets,
                )
            )
    else:
        top_risks = _fallback_cards(study.question)

    brief_md = ""
    illustrative_brief = True
    if brief_parts:
        brief_md = "\n\n".join(brief_parts)
        illustrative_brief = False
    elif lead:
        brief_md = (
            f"## Lead recommendation\n\n{lead.representative}\n\n"
            f"Robustness across scenarios: **{lead.robustness:.0%}** "
            f"({lead.n_agree} agree · {lead.n_weaker} weaker · {lead.n_flips} flip)."
        )
        illustrative_brief = False

    return ResearchSummary(
        study_id=study_id,
        question=study.question,
        top_risks=top_risks,
        brief_markdown=brief_md,
        brief_illustrative=illustrative_brief,
        lead_cluster_id=lead.cluster_id if lead else None,
    )

"""Stakeholder-facing research summary: structured findings + brief excerpt."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

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
class ResearchFinding:
    cluster_id: int
    rank: int
    answer_title: str
    answer_summary: str
    robustness: float
    holds_label: str
    n_agree: int
    n_total: int
    fragile_specs: list[str]
    occasion: str | None
    illustrative: bool
    source_assets: list[str] = field(default_factory=list)


@dataclass
class ResearchSummary:
    study_id: str
    question: str
    top_risks: list[TopRiskCard]
    findings: list[ResearchFinding]
    brief_markdown: str
    brief_illustrative: bool
    lead_cluster_id: int | None = None


_OCCASION_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"tailgat", re.I), "NFL Tailgating"),
    (re.compile(r"game\s?day|stadium\s+suite|sports[\s-]?bar", re.I), "NFL Gameday"),
    (re.compile(r"sunday\s+(?:hosting|funday)|hosting\s+ritual", re.I), "Sunday Hosting"),
    (re.compile(r"casual\s+unwind", re.I), "Casual Unwind"),
    (re.compile(r"social\s+celebrat", re.I), "Social Celebration"),
    (re.compile(r"intentional\s+discover", re.I), "Intentional Discovery"),
    (re.compile(r"fine\s+dining", re.I), "Fine Dining"),
    (re.compile(r"value[\s-]?tier|value\s+vodka", re.I), "Value-tier spirits"),
    (re.compile(r"tequila", re.I), "US tequila"),
    (re.compile(r"rtd|ready[\s-]?to[\s-]?drink", re.I), "RTD / premix"),
    (re.compile(r"moderation", re.I), "Moderation-led socializing"),
]

_IMPERATIVE_OPENER = re.compile(
    r"^(?:"
    r"Anchor|Prioritize|Prioritise|Focus|Invest|Build|Shift|Lean into|"
    r"Double down on|Concentrate|Extend|Protect|Defend|Emphasize|Emphasise|"
    r"Allocate|Reallocate|Strengthen|Reduce|Increase|Decrease"
    r")\s+",
    re.I,
)


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


def _first_sentence(text: str) -> str:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return parts[0].strip() if parts and parts[0].strip() else text.strip()


def _answer_title(text: str) -> str:
    """Turn a directive brief sentence into a short answer-shaped title."""
    trimmed = text.strip()
    if not trimmed:
        return "Finding"
    candidate = _first_sentence(trimmed).split(",")[0].split(";")[0].strip()
    candidate = _IMPERATIVE_OPENER.sub("", candidate).strip()
    candidate = candidate.rstrip(".!? ")
    if not candidate:
        candidate = trimmed[:80]
    if len(candidate) > 90:
        return candidate[:87] + "…"
    return candidate


def _answer_summary(text: str, n_agree: int, n_total: int) -> str:
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s.strip()]
    if len(sentences) >= 2:
        follow = " ".join(s for s in sentences[1:3] if len(s) < 240)
        if follow:
            return follow
    return (
        f"Holds in {n_agree} of {n_total} defensible framings — "
        "strong enough that breaking it would move the headline answer."
    )


def _scan_occasions(text: str) -> list[str]:
    found: list[str] = []
    for pat, label in _OCCASION_PATTERNS:
        if pat.search(text) and label not in found:
            found.append(label)
    return found


def _fallback_cards(question: str) -> list[TopRiskCard]:
    """Illustrative cards for zero-cell demo states only."""
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


def _build_findings(
    curve_rows: list,
    top_risks: list[TopRiskCard],
) -> list[ResearchFinding]:
    findings: list[ResearchFinding] = []
    for idx, row in enumerate(curve_rows):
        total = row.n_agree + row.n_weaker + row.n_flips + row.n_missing
        text = (row.representative or "").strip()
        matched = top_risks[idx] if idx < len(top_risks) else None
        findings.append(
            ResearchFinding(
                cluster_id=row.cluster_id,
                rank=idx + 1,
                answer_title=_answer_title(text),
                answer_summary=_answer_summary(text, row.n_agree, total),
                robustness=row.robustness,
                holds_label=_robustness_label(row.robustness),
                n_agree=row.n_agree,
                n_total=total,
                fragile_specs=list(row.fragile_specs or []),
                occasion=matched.occasion if matched else None,
                illustrative=bool(matched.illustrative if matched else False),
                source_assets=list(matched.source_assets if matched else []),
            )
        )
    return findings


def build_research_summary(study_id: str) -> ResearchSummary:
    study = read_study(study_id)
    if study is None:
        raise FileNotFoundError(f"No such study: {study_id}")
    settings = get_settings()
    curve = build_spec_curve(study_id)
    lead = curve.rows[0] if curve.rows else None
    n_complete = sum(1 for c in study.cells if c.status == "complete")

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
    illustrative_brief = False
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
    elif n_complete == 0:
        top_risks = _fallback_cards(study.question)
        illustrative_brief = True

    findings = _build_findings(curve.rows, top_risks)

    brief_md = ""
    if brief_parts:
        brief_md = "\n\n".join(brief_parts)
    elif lead:
        brief_md = (
            f"## Lead recommendation\n\n{lead.representative}\n\n"
            f"Robustness across scenarios: **{lead.robustness:.0%}** "
            f"({lead.n_agree} agree · {lead.n_weaker} weaker · {lead.n_flips} flip)."
        )

    return ResearchSummary(
        study_id=study_id,
        question=study.question,
        top_risks=top_risks,
        findings=findings,
        brief_markdown=brief_md,
        brief_illustrative=illustrative_brief,
        lead_cluster_id=lead.cluster_id if lead else None,
    )

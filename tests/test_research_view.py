"""Tests for stakeholder research summary payloads."""
from __future__ import annotations

from diageo_research.research_view import (
    ResearchFinding,
    _answer_title,
    _build_findings,
    build_research_summary,
)


def test_answer_title_strips_imperative_opener() -> None:
    assert _answer_title("Anchor FY27 spend on casual unwind occasions.") == (
        "FY27 spend on casual unwind occasions"
    )
    assert _answer_title("Social celebration remains the lead growth pocket.") == (
        "Social celebration remains the lead growth pocket"
    )


def test_build_findings_shape() -> None:
    class Row:
        cluster_id = 1
        representative = "Prioritize NFL tailgating for Crown Royal."
        n_agree = 3
        n_weaker = 1
        n_flips = 0
        n_missing = 0
        robustness = 0.75
        fragile_specs: list[str] = ["cohort__loyal"]

    findings = _build_findings([Row()], [])
    assert len(findings) == 1
    f: ResearchFinding = findings[0]
    assert f.cluster_id == 1
    assert f.n_agree == 3
    assert f.n_total == 4
    assert "NFL" in f.answer_title or "tailgating" in f.answer_title.lower()


def test_build_research_summary_missing_study_raises() -> None:
    try:
        build_research_summary("study_does_not_exist_zzzz")
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("expected FileNotFoundError")

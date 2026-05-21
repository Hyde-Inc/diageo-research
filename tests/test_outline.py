"""Tests for the outline-first assignment helpers (improvement #2)."""
from diageo_research.models import OutlineSection, Persona
from diageo_research.outline import (
    _ensure_full_coverage,
    _round_robin,
)


def _persona(i: int, persona_type: str = "expert") -> Persona:
    return Persona(
        id=f"p{i}",
        name=f"Persona {i}",
        role="role",
        lens="lens",
        description="d",
        system_prompt="s",
        persona_type=persona_type,  # type: ignore[arg-type]
    )


def test_round_robin_assigns_every_section_to_at_least_one_persona():
    personas = [_persona(1), _persona(2)]
    sections = [
        OutlineSection(heading="A"),
        OutlineSection(heading="B"),
        OutlineSection(heading="C"),
    ]
    out = _round_robin(personas, sections)
    flat = [h for hs in out.values() for h in hs]
    assert set(flat) == {"A", "B", "C"}


def test_ensure_full_coverage_fills_missing_sections():
    personas = [_persona(1), _persona(2)]
    sections = [
        OutlineSection(heading="A"),
        OutlineSection(heading="B"),
        OutlineSection(heading="C"),
    ]
    partial = {"p1": ["A"], "p2": ["B"]}  # 'C' missing
    fixed = _ensure_full_coverage(partial, personas, sections)
    flat = [h for hs in fixed.values() for h in hs]
    assert "C" in flat

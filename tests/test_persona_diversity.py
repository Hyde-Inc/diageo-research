import pytest

from diageo_research.models import Persona
from diageo_research.persona_generator import _normalize_role, _validate_diversity


def _p(i: int, role: str, persona_type: str = "expert", name: str | None = None) -> Persona:
    return Persona(
        id=f"p{i}",
        name=name or role.title(),
        role=role,
        lens="...",
        description="...",
        system_prompt="...",
        persona_type=persona_type,  # type: ignore[arg-type]
    )


def test_normalize_role_collapses_modifiers():
    assert _normalize_role("Senior Pricing Strategist") == "pricing"
    assert _normalize_role("Pricing Analyst") == "pricing"
    assert _normalize_role("Lead Brand Researcher") == "brand"


def test_validate_diversity_drops_duplicates():
    personas = [
        _p(1, "Pricing Strategist"),
        _p(2, "Senior Pricing Analyst"),  # same family
        _p(3, "Regulatory Counsel"),
        _p(4, "Supply Chain Analyst"),
    ]
    out = _validate_diversity(personas, n=4)
    roles = [_normalize_role(p.role) for p in out]
    assert len(set(roles)) == len(roles)
    assert len(out) == 3


def test_validate_diversity_raises_when_too_few():
    personas = [
        _p(1, "Pricing Strategist"),
        _p(2, "Pricing Strategist"),
    ]
    with pytest.raises(RuntimeError):
        _validate_diversity(personas, n=4)


def test_validate_diversity_consumers_dedupe_by_name_anchor():
    """Two consumers with identical 'Houston tequila buyer' anchors collapse to one,
    but consumers with different demographic anchors are kept even if role wording matches."""
    personas = [
        _p(1, "Drinker", persona_type="consumer", name="Marisol, 26, Houston tequila buyer"),
        _p(2, "Drinker", persona_type="consumer", name="Marisol, 26, Houston tequila buyer"),
        _p(3, "Drinker", persona_type="consumer", name="Devon, 34, Toronto sober-curious millennial"),
        _p(4, "Pricing Strategist", persona_type="expert"),
    ]
    out = _validate_diversity(personas, n=4)
    ids = {p.id for p in out}
    assert "p1" in ids
    assert "p2" not in ids  # duplicate consumer dropped
    assert "p3" in ids
    assert "p4" in ids


def test_validate_diversity_keeps_both_types():
    """A hybrid panel of consumers + experts retains all unique members."""
    personas = [
        _p(1, "Drinker", persona_type="consumer", name="Maria, 28, NY"),
        _p(2, "Drinker", persona_type="consumer", name="Devon, 34, Toronto"),
        _p(3, "Pricing Strategist", persona_type="expert"),
        _p(4, "Channel Strategist", persona_type="expert"),
    ]
    out = _validate_diversity(personas, n=4)
    assert len(out) == 4

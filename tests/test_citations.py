from diageo_research.citations import (
    extract_markers,
    filter_used,
    references_section,
    renumber_global,
)
from diageo_research.models import Citation, SubReport


def test_extract_markers():
    text = "Spirits CPI rose 4.2% [B1] while retail sales were flat [Q2] [B1]."
    assert extract_markers(text) == ["B1", "Q2", "B1"]


def test_filter_used_keeps_only_cited():
    available = [
        Citation(cite_id="B1", source="browser", url="u1"),
        Citation(cite_id="B2", source="browser", url="u2"),
        Citation(cite_id="Q1", source="duckdb", sql="select 1"),
    ]
    text = "Findings on price [B1] and a query [Q1]."
    kept = filter_used(available, text)
    assert {c.cite_id for c in kept} == {"B1", "Q1"}


def test_renumber_global_dedupes_and_remaps():
    cites_a = [
        Citation(cite_id="B1", source="browser", url="https://a"),
        Citation(cite_id="Q1", source="duckdb", sql="SELECT 1"),
    ]
    cites_b = [
        Citation(cite_id="B1", source="browser", url="https://a"),  # duplicate URL
        Citation(cite_id="B2", source="browser", url="https://b"),
    ]
    subs = [
        SubReport(persona_id="p1", persona_name="A", markdown="claim x [B1] and stat [Q1]", citations=cites_a),
        SubReport(persona_id="p2", persona_name="B", markdown="alt [B1] plus other [B2]", citations=cites_b),
    ]
    renumbered, global_cites = renumber_global(subs)
    ids = [c.cite_id for c in global_cites]
    assert ids == ["S1", "S2", "S3"]  # https://a, SELECT 1, https://b
    assert "[S1]" in renumbered[0].markdown and "[S2]" in renumbered[0].markdown
    assert "[S1]" in renumbered[1].markdown and "[S3]" in renumbered[1].markdown


def test_references_section_formats_both_sources():
    cites = [
        Citation(cite_id="S1", source="browser", url="https://x", title="Headline", snippet="excerpt..."),
        Citation(cite_id="S2", source="duckdb", sql="SELECT 1", snippet="row=1"),
    ]
    s = references_section(cites)
    assert "## References" in s
    assert "[S1]" in s and "Headline" in s and "https://x" in s
    assert "[S2]" in s and "DuckDB query" in s

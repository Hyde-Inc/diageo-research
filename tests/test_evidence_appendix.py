"""The Evidence Appendix bundles every verified DuckDB artifact that wasn't
already embedded in a main section, grouped by the analyst lens (sub-report)
that produced it. This is what makes the brief 'combine key graphs from each
perspective interview'."""
from diageo_research.charts import ChartArtifact
from diageo_research.models import Citation, SubReport
from diageo_research.summarizer import _build_evidence_appendix


def _art(cid: str, chart: bool = True) -> ChartArtifact:
    return ChartArtifact(
        cite_id=cid,
        title=f"title {cid}",
        table_md=f"TABLE-{cid}",
        chart_md=f"```mermaid\nCHART-{cid}\n```" if chart else None,
        chart_kind="line" if chart else None,
    )


def _sub(persona_id: str, persona_name: str, *cite_ids: str) -> SubReport:
    return SubReport(
        persona_id=persona_id,
        persona_name=persona_name,
        markdown="...",
        citations=[Citation(cite_id=cid, source="duckdb", sql="x", verified=True) for cid in cite_ids],
    )


def test_appendix_bundles_unembedded_artifacts_grouped_by_persona():
    subs = [
        _sub("p1", "Lens A", "S1", "S2"),
        _sub("p2", "Lens B", "S3"),
    ]
    artifacts = {cid: _art(cid) for cid in ("S1", "S2", "S3")}
    # main sections embedded S1 already; S2 and S3 are unembedded
    embedded: set[tuple[str, str]] = {("CHART", "S1"), ("TABLE", "S1")}
    md = _build_evidence_appendix(subs, artifacts, embedded)

    assert "## Evidence appendix" in md
    assert "From Lens A's analysis" in md
    assert "From Lens B's analysis" in md
    # S1 was already embedded → must NOT re-appear
    assert "CHART-S1" not in md
    assert "TABLE-S1" not in md
    # S2 and S3 are surfaced here
    assert "CHART-S2" in md
    assert "TABLE-S2" in md
    assert "CHART-S3" in md
    assert "TABLE-S3" in md


def test_appendix_returns_empty_when_all_artifacts_embedded():
    subs = [_sub("p1", "Lens A", "S1")]
    artifacts = {"S1": _art("S1")}
    embedded = {("CHART", "S1"), ("TABLE", "S1")}
    md = _build_evidence_appendix(subs, artifacts, embedded)
    assert md == ""


def test_appendix_does_not_repeat_artifacts_across_personas():
    """If S2 was cited by both p1 and p2 (e.g. after renumbering dedup), it
    appears in the appendix only under the FIRST persona that contributed it."""
    subs = [
        _sub("p1", "Lens A", "S2"),
        _sub("p2", "Lens B", "S2"),
    ]
    artifacts = {"S2": _art("S2")}
    embedded: set[tuple[str, str]] = set()
    md = _build_evidence_appendix(subs, artifacts, embedded)
    assert md.count("CHART-S2") == 1
    assert md.count("TABLE-S2") == 1
    # Should be in Lens A's group (first occurrence)
    assert "Lens A" in md
    # Lens B should NOT have any artifacts of its own and thus not appear
    assert "From Lens B" not in md


def test_appendix_handles_artifacts_without_charts():
    subs = [_sub("p1", "Lens A", "S1")]
    artifacts = {"S1": _art("S1", chart=False)}  # multi-dim crosstab — table only
    embedded: set[tuple[str, str]] = set()
    md = _build_evidence_appendix(subs, artifacts, embedded)
    assert "TABLE-S1" in md
    assert "CHART-S1" not in md  # there is no chart to render


def test_appendix_skips_orphan_header_when_both_already_embedded():
    """Regression: if both the chart AND table for an artifact were already
    embedded in a main section, the appendix used to still emit a `**[Sn]**
    title` header line with no content below it. Skip the whole entry."""
    subs = [_sub("p1", "Lens A", "S1", "S2")]
    artifacts = {"S1": _art("S1"), "S2": _art("S2")}
    # Both S1's chart AND table were already embedded above
    embedded: set[tuple[str, str]] = {("CHART", "S1"), ("TABLE", "S1")}
    md = _build_evidence_appendix(subs, artifacts, embedded)
    # S2 surfaces normally
    assert "CHART-S2" in md and "TABLE-S2" in md
    # S1 was fully embedded — no orphan header in appendix
    assert "**[S1]**" not in md


def test_appendix_omits_duplicate_title_when_only_table_surfaces():
    """When only the table needs to render (chart was already embedded
    above), don't add a `**[Sn]** title` header — the table caption already
    carries the title."""
    subs = [_sub("p1", "Lens A", "S1")]
    artifacts = {"S1": _art("S1")}
    embedded: set[tuple[str, str]] = {("CHART", "S1")}  # chart already used
    md = _build_evidence_appendix(subs, artifacts, embedded)
    # Table renders without a duplicate cite header above it
    assert "TABLE-S1" in md
    # No leading `**[S1]** title` line
    assert "**[S1]**" not in md


def test_appendix_skips_browser_citations():
    """Browser citations don't get chart/table artifacts, so they're not in
    the artifacts dict — confirm the appendix doesn't try to surface them."""
    sub = SubReport(
        persona_id="p1",
        persona_name="Lens A",
        markdown="...",
        citations=[Citation(cite_id="B1", source="browser", url="https://x.com", verified=None)],
    )
    md = _build_evidence_appendix([sub], artifacts={}, embedded=set())
    assert md == ""

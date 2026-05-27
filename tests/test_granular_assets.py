"""Unit tests for the granular asset module.

Covers the four pure-Python surfaces of
:mod:`diageo_research.granular_assets`:

1. Asset key shape — content-addressed and stable across re-runs.
2. ``human_source_label`` — pretty labels for browser URLs and
   DuckDB SQL, with an honest "Source unavailable" fallback.
3. ``parse_brief_claims`` — pulls cited sentences out of a brief
   markdown into addressable :class:`ParsedClaim` rows.
4. ``kind_for_asset_key`` — maps an asset key path to the FE-facing
   filter kind (``persona``, ``turn``, ``tool_call``, …).

Emit functions are exercised through an in-memory ephemeral Dagster
instance in :mod:`test_granular_assets_emit`. These tests don't need
Dagster — they pin the contracts the FE depends on.
"""
from __future__ import annotations

from diageo_research.granular_assets import (
    CITATION_ASSET_PREFIX,
    CLAIM_ASSET_PREFIX,
    PERSONA_ASSET_PREFIX,
    TOOL_CALL_ASSET_PREFIX,
    TURN_ASSET_PREFIX,
    citation_asset_key,
    claim_asset_key,
    human_source_label,
    kind_for_asset_key,
    parse_brief_claims,
    persona_asset_key,
    tool_call_asset_key,
    turn_asset_key,
)
from diageo_research.models import Citation


# ----------------------------------------------------------- Asset key shape


def test_persona_asset_key_is_content_addressed_and_stable() -> None:
    """Same (question, axes, persona_id) → same key, regardless of run."""
    k1 = persona_asset_key(
        question="What is happening with prices?",
        axes={"lens": "demand_space"},
        persona_id="p1",
    )
    k2 = persona_asset_key(
        question="What is happening with prices?",
        axes={"lens": "demand_space"},
        persona_id="p1",
    )
    assert k1 == k2
    # 4-tuple: prefix, question_hash, axes_signature, persona_id.
    assert k1[0] == PERSONA_ASSET_PREFIX
    assert len(k1) == 4
    assert k1[-1] == "p1"


def test_persona_asset_key_axes_change_invalidates_key() -> None:
    """Different axes mean different cell signature → different key."""
    a = persona_asset_key(
        question="Q?", axes={"lens": "demand_space"}, persona_id="p1"
    )
    b = persona_asset_key(
        question="Q?", axes={"lens": "cohort"}, persona_id="p1"
    )
    assert a != b
    # Hash + signature differ, but prefix and persona id are still pinned.
    assert a[0] == b[0] == PERSONA_ASSET_PREFIX
    assert a[-1] == b[-1]


def test_turn_asset_key_includes_turn_marker() -> None:
    k = turn_asset_key(
        question="Q?", axes=None, persona_id="p1", turn_idx=3
    )
    assert k[0] == TURN_ASSET_PREFIX
    assert k[-2] == "p1"
    assert k[-1] == "t3"


def test_tool_call_asset_key_includes_seq_marker() -> None:
    k = tool_call_asset_key(
        question="Q?", axes=None, persona_id="p1", seq=2
    )
    assert k[0] == TOOL_CALL_ASSET_PREFIX
    assert k[-2] == "p1"
    assert k[-1] == "c2"


def test_citation_asset_key_uses_cite_id_tail() -> None:
    k = citation_asset_key(question="Q?", axes=None, cite_id="S4")
    assert k[0] == CITATION_ASSET_PREFIX
    assert k[-1] == "S4"


def test_claim_asset_key_mixes_text_so_text_change_invalidates() -> None:
    a = claim_asset_key(question="Q?", axes=None, idx=1, text="Spirits down 3%")
    b = claim_asset_key(question="Q?", axes=None, idx=1, text="Spirits up 3%")
    assert a != b
    assert a[0] == CLAIM_ASSET_PREFIX
    # ``c001_<hash>`` — idx is zero-padded so a 100-claim brief still sorts.
    assert a[-1].startswith("c001_")


def test_no_axes_falls_back_to_stable_signature() -> None:
    """``axes=None`` still produces a deterministic key for single-shot runs."""
    a = persona_asset_key(question="Q?", axes=None, persona_id="p1")
    b = persona_asset_key(question="Q?", axes={}, persona_id="p1")
    # Empty axes are treated as no-axes for signature purposes.
    assert a == b


# ----------------------------------------------------------- Source labels


def test_human_source_label_recognises_known_hosts() -> None:
    citation = Citation(
        cite_id="B1",
        source="browser",
        url="https://www.bls.gov/news.release/cpi.htm",
        title="CPI release",
        snippet="off-premise spirits index up 2.3% YoY.",
    )
    assert human_source_label(citation) == "BLS (US Bureau of Labor Statistics)"


def test_human_source_label_handles_subdomains() -> None:
    citation = Citation(
        cite_id="B2",
        source="browser",
        url="https://fred.stlouisfed.org/series/CPIENGSL",
        title="CPI: Energy services",
        snippet="...",
    )
    assert human_source_label(citation) == "FRED (St. Louis Fed)"


def test_human_source_label_unknown_host_falls_back_to_hostname() -> None:
    citation = Citation(
        cite_id="B3",
        source="browser",
        url="https://example.com/article",
        title="An article",
        snippet="...",
    )
    label = human_source_label(citation)
    assert label == "example.com"


def test_human_source_label_for_duckdb_uses_table_hint() -> None:
    citation = Citation(
        cite_id="Q1",
        source="duckdb",
        sql="SELECT week, sum(units) FROM bls_cpi WHERE category='Spirits' GROUP BY 1",
        snippet="rows...",
    )
    label = human_source_label(citation)
    assert label.startswith("Internal SQL:")
    assert "BLS CPI series" in label


def test_human_source_label_for_duckdb_without_from_falls_back() -> None:
    citation = Citation(
        cite_id="Q2",
        source="duckdb",
        sql="SHOW TABLES",
        snippet="...",
    )
    label = human_source_label(citation)
    assert label == "Internal SQL (DuckDB)"


def test_human_source_label_browser_missing_url_returns_title_then_unavailable() -> None:
    # Browser citation with a title but no URL: surface the title.
    titled = Citation(
        cite_id="B4",
        source="browser",
        url=None,
        title="Internal note",
        snippet="...",
    )
    assert human_source_label(titled) == "Internal note"
    # Browser citation with neither URL nor title: honest "Web source" fallback.
    bare = Citation(cite_id="B5", source="browser", url=None, snippet="...")
    assert human_source_label(bare) == "Web source"


# --------------------------------------------------------- Claim parser


_SAMPLE_BRIEF = """# Brief

## Executive summary

Spirits volume fell 3.2% YoY [B1]. Tequila gained share against vodka [B2][Q1].

> This blockquote line is ignored even with [B9] inside it.

## Drivers

The cohort under 60k income drove the decline [Q2]. Imports stayed flat though,
because the pull-forward effect from 2024 was absorbed [S3].

```
ignore code blocks like [B7] entirely
```

| not | parsed |
| --- | --- |
|  [B8] | nope |

Loose paragraph without citations gets skipped.
"""


def test_parse_brief_claims_extracts_cited_sentences() -> None:
    claims = parse_brief_claims(_SAMPLE_BRIEF)
    # The blockquote, code block, and table rows must NOT show up.
    cite_id_lists = [c.cite_ids for c in claims]
    assert ["B1"] in cite_id_lists
    assert ["B2", "Q1"] in cite_id_lists
    assert ["Q2"] in cite_id_lists
    assert ["S3"] in cite_id_lists
    # Anything inside ``>`` / ``|`` / fenced code is skipped.
    for c in claims:
        assert "B9" not in c.cite_ids
        assert "B7" not in c.cite_ids
        assert "B8" not in c.cite_ids


def test_parse_brief_claims_assigns_monotonic_indices_and_section() -> None:
    claims = parse_brief_claims(_SAMPLE_BRIEF)
    # Claims are emitted in brief order with monotonic idx.
    assert [c.idx for c in claims] == sorted(c.idx for c in claims)
    # Section header captured for downstream UI grouping.
    sections = {c.section for c in claims}
    assert "Executive summary" in sections
    assert "Drivers" in sections


def test_parse_brief_claims_empty_input_returns_empty_list() -> None:
    assert parse_brief_claims("") == []
    assert parse_brief_claims("\n\n   \n") == []


def test_parse_brief_claims_dedupes_cite_ids_within_a_claim() -> None:
    md = "A claim about something [B1][B1] with repeat citation.\n"
    claims = parse_brief_claims(md)
    assert len(claims) == 1
    assert claims[0].cite_ids == ["B1"]


# ------------------------------------------------------ kind_for_asset_key


def test_kind_for_asset_key_maps_each_prefix() -> None:
    assert kind_for_asset_key([PERSONA_ASSET_PREFIX, "qh", "sig", "p1"]) == "persona"
    assert kind_for_asset_key([TURN_ASSET_PREFIX, "qh", "sig", "p1", "t1"]) == "turn"
    assert kind_for_asset_key([TOOL_CALL_ASSET_PREFIX, "qh", "sig", "p1", "c1"]) == "tool_call"
    assert kind_for_asset_key([CITATION_ASSET_PREFIX, "qh", "sig", "S1"]) == "citation"
    assert kind_for_asset_key([CLAIM_ASSET_PREFIX, "qh", "sig", "c001_abc"]) == "claim"


def test_kind_for_asset_key_research_cell_and_stage() -> None:
    assert kind_for_asset_key(["research_cell", "qh", "sig"]) == "cell"
    assert kind_for_asset_key(["synthesis"]) == "stage"


def test_kind_for_asset_key_empty_returns_unknown() -> None:
    assert kind_for_asset_key([]) == "unknown"

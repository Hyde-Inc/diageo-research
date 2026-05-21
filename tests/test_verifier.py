"""Tests for the verifier pass — re-running [Q?] SQL and checking the quoted
numbers still appear in the result."""
import duckdb
import pytest

from diageo_research.models import Citation, SubReport
from diageo_research.verifier import (
    _normalize_number,
    _numbers_near_marker,
    verify_subreports,
)


def test_normalize_number_collapses_units_and_separators():
    # Values >= 10 fingerprint as the truncated integer part: 93.1, 93.4, 93.9
    # all collapse together (small SQL rounding deltas survive); but 999.9 and
    # 100.0 stay distinct.
    assert _normalize_number("93.1") == "93"
    assert _normalize_number("93.4") == "93"
    assert _normalize_number("93,100") == "93100"
    assert _normalize_number("999.9") == "999"
    assert _normalize_number("100.0") == "100"
    # below 1 we keep 2 fractional digits with leading zero stripped
    assert _normalize_number("0.62") == ".62"
    # values between 1 and 10 keep one fractional digit
    assert _normalize_number("-1.0") == "-1.0"
    assert _normalize_number("abc") is None
    # Desired fuzzy collisions: 93.1 ≈ 93.4 should fingerprint identically.
    assert _normalize_number("93.1") == _normalize_number("93.4")
    # Anti-collision: 999.9 must NOT fingerprint to 100.
    assert _normalize_number("999.9") != _normalize_number("100.0")


def test_numbers_near_marker_pulls_from_window():
    text = "Spirits CPI rose to 290.8 by 2024 [Q1] from 262.8 in 2021."
    nums = _numbers_near_marker(text, "Q1")
    # both adjacent numbers should be captured
    assert _normalize_number("290.8") in nums
    assert _normalize_number("262.8") in nums


def test_numbers_near_marker_ignores_unrelated_marker():
    text = "Whisky fell 15.5% [Q2] last year; vodka grew 8.8% [Q3]."
    near_q2 = _numbers_near_marker(text, "Q2")
    near_q3 = _numbers_near_marker(text, "Q3")
    # Both markers' windows overlap in this short string, which is fine for the
    # neighbourhood heuristic — we just need each marker to see its own number.
    assert _normalize_number("15.5") in near_q2
    assert _normalize_number("8.8") in near_q3


@pytest.mark.asyncio
async def test_verify_subreports_marks_verified_and_flagged(monkeypatch, tmp_path):
    """A citation whose quoted number still shows up in the re-exec is marked
    verified=True; one that quotes a number absent from the result is False."""
    from diageo_research.config import get_settings

    db_path = tmp_path / "test.duckdb"
    monkeypatch.setenv("DUCKDB_PATH", str(db_path))
    get_settings.cache_clear()

    conn = duckdb.connect(str(db_path))
    conn.execute("CREATE TABLE prices(category VARCHAR, value DOUBLE)")
    conn.execute("INSERT INTO prices VALUES ('whisky', 290.8), ('vodka', 100.0)")
    conn.close()

    cite_good = Citation(
        cite_id="Q1",
        source="duckdb",
        sql="SELECT value FROM prices WHERE category = 'whisky'",
        snippet="value=290.8",
    )
    cite_bad = Citation(
        cite_id="Q2",
        source="duckdb",
        sql="SELECT value FROM prices WHERE category = 'vodka'",
        snippet="value=999.9",
    )
    # Keep the two markers far apart so their neighborhood windows don't overlap.
    padding = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " * 8
    md = (
        f"Spirits CPI reached 290.8 by 2024 [Q1]. {padding}"
        f"Hypothetically the value 999.9 appeared [Q2]."
    )
    sub = SubReport(
        persona_id="p1",
        persona_name="Tester",
        markdown=md,
        citations=[cite_good, cite_bad],
    )

    out = await verify_subreports([sub])
    assert out[0].citations[0].verified is True
    # Q2 expects 999.9 but the vodka SQL returns 100.0 — no overlap → flagged.
    assert out[0].citations[1].verified is False
    assert "matched" in (out[0].citations[0].verification_note or "")
    assert (
        "appeared in re-exec" in (out[0].citations[1].verification_note or "")
        or "0 rows" in (out[0].citations[1].verification_note or "")
    )
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_verify_subreports_skips_browser_citations(monkeypatch, tmp_path):
    """Browser citations are not auto-verified in this pass."""
    cite = Citation(cite_id="B1", source="browser", url="https://example.com")
    sub = SubReport(persona_id="p1", persona_name="x", markdown="claim [B1]", citations=[cite])
    out = await verify_subreports([sub])
    assert out[0].citations[0].verified is None


@pytest.mark.asyncio
async def test_verify_subreports_flags_low_match_ratio(monkeypatch, tmp_path):
    """Previous behavior: 1-of-14 number matches was enough to mark ✓ — that
    let cite IDs slip through with 7% reproducibility. Now we require ≥50% or
    ≥3 absolute matches. A citation that quotes 10 numbers but only matches
    1 of them must be flagged."""
    from diageo_research.config import get_settings

    db_path = tmp_path / "verifier_low.duckdb"
    monkeypatch.setenv("DUCKDB_PATH", str(db_path))
    get_settings.cache_clear()

    conn = duckdb.connect(str(db_path))
    conn.execute("CREATE TABLE t(v DOUBLE)")
    conn.execute("INSERT INTO t VALUES (290.8)")
    conn.close()

    # Markdown quotes 10 numbers near the marker but only 290.8 is in the SQL.
    cite = Citation(cite_id="Q1", source="duckdb", sql="SELECT v FROM t")
    md = (
        "Big numbers: 100, 200, 300, 400, 500, 600, 700, 800, 900, 290.8 [Q1]."
    )
    sub = SubReport(persona_id="p1", persona_name="x", markdown=md, citations=[cite])
    out = await verify_subreports([sub])
    c = out[0].citations[0]
    assert c.verified is False
    assert "below verification threshold" in (c.verification_note or "")
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_verify_subreports_passes_high_match_ratio(monkeypatch, tmp_path):
    """A citation where most numbers reproduce should pass."""
    from diageo_research.config import get_settings

    db_path = tmp_path / "verifier_high.duckdb"
    monkeypatch.setenv("DUCKDB_PATH", str(db_path))
    get_settings.cache_clear()

    conn = duckdb.connect(str(db_path))
    conn.execute("CREATE TABLE t(v DOUBLE)")
    conn.execute("INSERT INTO t VALUES (100), (200), (300)")
    conn.close()

    cite = Citation(cite_id="Q1", source="duckdb", sql="SELECT v FROM t")
    md = "Three values: 100, 200, 300 [Q1]."
    sub = SubReport(persona_id="p1", persona_name="x", markdown=md, citations=[cite])
    out = await verify_subreports([sub])
    c = out[0].citations[0]
    assert c.verified is True

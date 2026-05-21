"""Tests for malformed-marker stripping + inline verifier badging."""
from diageo_research.citations import (
    render_verified_badges_inline,
    strip_malformed_markers,
)
from diageo_research.models import Citation


def test_strip_malformed_marker_drops_persona_attribution_tags():
    text = (
        "Tyler said the third drink trades down [B-Tyler, B-Marisol]. "
        "Crown Royal is at $54 [B2]. The analyst sees this as cross-price "
        "switching [Q-p4 reaction]. Real cite: [S5]."
    )
    out = strip_malformed_markers(text)
    assert "[B-Tyler" not in out and "[B-Marisol" not in out
    assert "[Q-p4 reaction]" not in out
    # Valid markers survive
    assert "[B2]" in out
    assert "[S5]" in out


def test_strip_malformed_marker_drops_valid_prefix_with_junk():
    """The trickier case: `[S5, p2→p1]` has a valid PREFIX (`S5`) followed by
    junk. The earlier regex (which required a non-digit immediately after
    the prefix) missed these and left orphan tokens in the text."""
    text = "claim [S5, p2→p1] another [B1, p2] third [Q3, persona=p4] real [S5]."
    out = strip_malformed_markers(text)
    assert "[S5," not in out
    assert "[B1," not in out
    assert "[Q3," not in out
    # The genuine [S5] at the end survives
    assert out.endswith("real [S5].")


def test_strip_keeps_all_valid_marker_forms():
    text = "claim [B1] [B12] [Q3] [Q99] [S5] [S100]."
    out = strip_malformed_markers(text)
    # Every valid marker preserved
    for tok in ["[B1]", "[B12]", "[Q3]", "[Q99]", "[S5]", "[S100]"]:
        assert tok in out


def test_render_verified_badges_appends_warning_for_flagged():
    cites = {
        "S1": Citation(cite_id="S1", source="duckdb", sql="SELECT 1", verified=True),
        "S2": Citation(cite_id="S2", source="duckdb", sql="SELECT 2", verified=False),
        "S3": Citation(cite_id="S3", source="browser", url="https://x", verified=None),
    }
    text = "verified claim [S1], flagged claim [S2], browser claim [S3]."
    out = render_verified_badges_inline(text, cites)
    assert "[S1]" in out  # no inline badge for verified (keeps prose clean)
    assert "[S2⚠]" in out  # flagged → inline ⚠
    assert "[S3]" in out  # browser citations not verified → no badge


def test_render_verified_badges_leaves_unknown_marker_untouched():
    out = render_verified_badges_inline("a [S99] b", {})
    assert "[S99]" in out

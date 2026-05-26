"""Tests for :mod:`diageo_research.keys`.

These pin the cross-study reuse contract: two cells with the same
intent (question + axes, and the same code / prompt version) must land
on the same Dagster asset key + partition. Drift here is the bug class
that re-runs already-paid-for cells, so we test the determinism with
both happy-path matches and adversarial whitespace / ordering tweaks.
"""
from __future__ import annotations

from diageo_research import keys


def test_hash_question_normalises_whitespace() -> None:
    """Extra whitespace and newlines must not change the question hash."""
    a = keys.hash_question("What is the impact of pricing?")
    b = keys.hash_question("  What    is\nthe   impact of pricing?  ")
    assert a == b
    assert len(a) == 12


def test_hash_axes_is_order_independent() -> None:
    """Dict-construction order must not change the axes hash."""
    a = {"lens": "demand_space", "cohort": "sub60k"}
    b = {"cohort": "sub60k", "lens": "demand_space"}
    assert keys.hash_axes(a) == keys.hash_axes(b)


def test_hash_axes_changes_with_value() -> None:
    """Different axis values must produce different hashes."""
    a = keys.hash_axes({"lens": "demand_space"})
    b = keys.hash_axes({"lens": "occasion"})
    assert a != b


def test_axes_signature_is_readable_and_sorted() -> None:
    """Signatures slot axes alphabetically and use dashes / underscores."""
    sig = keys.axes_signature({"lens": "demand_space", "cohort": "sub60k"})
    assert "cohort-sub60k" in sig
    assert "lens-demand-space" in sig
    # Sorted by axis name → cohort first, lens second.
    assert sig.index("cohort-") < sig.index("lens-")


def test_cell_signature_deterministic_for_equivalent_inputs() -> None:
    """Same question, same axes, same versions → same cell signature."""
    sig1 = keys.cell_signature(
        question="What is the impact of pricing?",
        axes={"lens": "demand_space", "cohort": "sub60k"},
        code_ver="codeabc123",
        prompt_ver="promptxyz",
    )
    sig2 = keys.cell_signature(
        question="  What    is\nthe   impact of pricing?  ",
        axes={"cohort": "sub60k", "lens": "demand_space"},
        code_ver="codeabc123",
        prompt_ver="promptxyz",
    )
    assert sig1 == sig2


def test_cell_signature_changes_with_code_version() -> None:
    """A code-version bump must invalidate cached materializations."""
    sig_a = keys.cell_signature(
        question="q", axes={"a": "1"}, code_ver="aaa", prompt_ver="bbb"
    )
    sig_b = keys.cell_signature(
        question="q", axes={"a": "1"}, code_ver="zzz", prompt_ver="bbb"
    )
    assert sig_a != sig_b


def test_cell_signature_changes_with_prompt_version() -> None:
    """A prompt edit must invalidate cached materializations too."""
    sig_a = keys.cell_signature(
        question="q", axes={"a": "1"}, code_ver="aaa", prompt_ver="bbb"
    )
    sig_b = keys.cell_signature(
        question="q", axes={"a": "1"}, code_ver="aaa", prompt_ver="ccc"
    )
    assert sig_a != sig_b


def test_cell_asset_key_path_shape() -> None:
    """``cell_asset_key_path`` returns a 3-element list with the prefix first."""
    path = keys.cell_asset_key_path("hello world", {"lens": "solo"})
    assert len(path) == 3
    assert path[0] == "research_cell"
    assert path[1] == keys.hash_question("hello world")
    assert path[2] == keys.axes_signature({"lens": "solo"})


def test_encode_decode_asset_key_roundtrip() -> None:
    """URL-safe encoding is a clean roundtrip."""
    path = ["research_cell", "abc123", "lens-solo__cohort-sub60k"]
    encoded = keys.encode_asset_key(path)
    assert "/" not in encoded  # URL-safe
    assert "+" not in encoded  # URL-safe
    assert keys.decode_asset_key(encoded) == path


def test_decode_asset_key_rejects_garbage() -> None:
    """Bad input raises ``ValueError`` rather than returning bogus paths."""
    import pytest

    with pytest.raises(ValueError):
        keys.decode_asset_key("not%%base64??")


def test_metadata_summary_contains_required_fields() -> None:
    """The materialization metadata bundle must surface the full fingerprint."""
    summary = keys.metadata_summary(
        question="What is the impact of pricing?",
        axes={"lens": "demand_space", "cohort": "sub60k"},
    )
    required = {
        "question",
        "question_hash",
        "axes",
        "axes_hash",
        "axes_signature",
        "code_version",
        "prompt_version",
        "cell_signature",
        "asset_key_path",
    }
    assert required.issubset(summary.keys())
    assert summary["asset_key_path"][0] == "research_cell"


def test_metadata_summary_accepts_extras() -> None:
    """Extras merge into the summary without mutating the canonical fields."""
    summary = keys.metadata_summary(
        question="q",
        axes={"a": "1"},
        extras=[("status", "complete"), ("cost_usd", 0.42)],
    )
    assert summary["status"] == "complete"
    assert summary["cost_usd"] == 0.42
    assert summary["question_hash"] == keys.hash_question("q")

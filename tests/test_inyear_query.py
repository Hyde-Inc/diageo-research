"""Tests for the M5 in-year-query path (decision snapshot + diff).

Three scenarios:

1. Snapshot helper — same inputs → identical hash block.
2. Diff helper — added / changed / invalidated semantics over two
   snapshot blocks.
3. ``GET /decisions/{id}/in-year`` — full round-trip through commit →
   evidence change → re-fetch, asserting the diff detects added,
   removed, and (coarse) changed pointers.

We monkeypatch the API's evidence collector so the diff test stays
hermetic; the underlying helpers don't need a live study on disk.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from diageo_research.granular_assets import (
    DECISION_ASSET_PREFIX,
    IN_YEAR_QUERY_ASSET_PREFIX,
    compute_decision_in_year_diff,
    compute_decision_snapshot,
    load_decision_asset,
)
from diageo_research.web import api as api_module
from diageo_research.web.api import app


@pytest.fixture()
def isolated_dagster_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> Path:
    monkeypatch.setenv("DAGSTER_HOME", str(tmp_path / "dagster_home"))
    return tmp_path


# ============================================================ Pure helpers


def test_compute_decision_snapshot_is_deterministic() -> None:
    """Same inputs → identical (evidence_hash, claims_hash, curve_hash)."""
    snap_a = compute_decision_snapshot(
        study_id="study_test",
        evidence_pointers=["pa", "pb", "pa"],  # duplicate stripped
        claim_ids=["c1", "c2"],
        curve_bytes=b"{\"x\":1}",
    )
    snap_b = compute_decision_snapshot(
        study_id="study_test",
        evidence_pointers=["pb", "pa"],
        claim_ids=["c2", "c1"],
        curve_bytes=b"{\"x\":1}",
    )
    assert snap_a == snap_b
    # The hashes are non-empty sha256 hex strings (64 chars).
    for h in ("evidence_hash", "claims_hash", "curve_hash"):
        assert len(snap_a[h]) == 64


def test_compute_decision_snapshot_curve_change_invalidates_curve_hash() -> None:
    snap_a = compute_decision_snapshot(
        study_id="study_test",
        evidence_pointers=["pa"],
        claim_ids=["c1"],
        curve_bytes=b"v1",
    )
    snap_b = compute_decision_snapshot(
        study_id="study_test",
        evidence_pointers=["pa"],
        claim_ids=["c1"],
        curve_bytes=b"v2",
    )
    # Only curve_hash should differ.
    assert snap_a["evidence_hash"] == snap_b["evidence_hash"]
    assert snap_a["claims_hash"] == snap_b["claims_hash"]
    assert snap_a["curve_hash"] != snap_b["curve_hash"]


def test_compute_decision_in_year_diff_detects_added_and_removed() -> None:
    snap = compute_decision_snapshot(
        study_id="study_test",
        evidence_pointers=["pa", "pb", "pc"],
        claim_ids=["c1"],
        curve_bytes=b"x",
    )
    current = compute_decision_snapshot(
        study_id="study_test",
        evidence_pointers=["pa", "pd"],
        claim_ids=["c1"],
        curve_bytes=b"x",
    )
    diff = compute_decision_in_year_diff(snapshot=snap, current=current)
    assert diff["evidence_added"] == ["pd"]
    assert diff["evidence_invalidated"] == ["pb", "pc"]
    # No claim/curve shift → no coarse "changed" common pointers.
    assert diff["evidence_changed"] == []


def test_compute_decision_in_year_diff_flags_common_when_curve_shifts() -> None:
    """When claims_hash or curve_hash differs, common pointers count as changed."""
    snap = compute_decision_snapshot(
        study_id="study_test",
        evidence_pointers=["pa", "pb"],
        claim_ids=["c1"],
        curve_bytes=b"v1",
    )
    current = compute_decision_snapshot(
        study_id="study_test",
        evidence_pointers=["pa", "pb"],
        claim_ids=["c1"],
        curve_bytes=b"v2",
    )
    diff = compute_decision_in_year_diff(snapshot=snap, current=current)
    assert diff["evidence_added"] == []
    assert diff["evidence_invalidated"] == []
    assert diff["evidence_changed"] == ["pa", "pb"]


# =============================================== API: full commit-to-diff


def _commit_decision(client: TestClient, *, study_id: str = "study_test") -> dict[str, Any]:
    body = {
        "scope": {
            "study_id": study_id,
            "driver_id": "crown-peach-tailgate",
            "finding_id": None,
        },
        "recommendation": "Lean tailgate spend into Crown Peach in NFL markets.",
        "confidence": {
            "sentence": "Holds in 8 of 10 framings.",
            "holds_in": 8,
            "of": 10,
            "label": "Medium",
        },
        "fragile_assumption": "If Peach cannibalizes flagship Crown.",
        "counterfactual_refs": [],
        "inputs_used": ["bls:CUUR0000SA0"],
        "owner": "maya",
    }
    r = client.post("/decisions", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_in_year_diff_returns_no_changes_when_evidence_set_is_stable(
    isolated_dagster_home: Path,
) -> None:
    """Commit a decision then immediately query — diff should be empty."""
    client = TestClient(app)
    commit = _commit_decision(client)
    decision_id = commit["decision_id"]

    r = client.get(f"/decisions/{decision_id}/in-year")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["decision_id"] == decision_id
    assert body["diff"]["evidence_added"] == []
    assert body["diff"]["evidence_changed"] == []
    assert body["diff"]["evidence_invalidated"] == []
    # Snapshot vs current hashes are identical when nothing has shifted.
    assert body["snapshot_hashes"] == body["current_hashes"]
    # Returned query asset_key points at the in_year_query namespace.
    assert body["asset_key"][0] == IN_YEAR_QUERY_ASSET_PREFIX
    # An InYearQueryAsset landed on disk under runs/inyearqueries/.
    on_disk = load_decision_asset("in_year_query", body["query_id"])
    assert on_disk is not None
    assert on_disk["bound_to"] == decision_id


def test_in_year_diff_detects_added_pointer_after_commit(
    isolated_dagster_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mutate the evidence-pointer set after commit; the diff must show
    the addition without re-reading the original snapshot block."""
    client = TestClient(app)
    commit = _commit_decision(client)
    decision_id = commit["decision_id"]
    original_pointers = commit["snapshot"]["evidence_pointers"]

    # Hot-swap the API's pointer collector to append a new pointer the
    # next time someone asks for the current state. The original
    # snapshot stays as-is on disk so the diff knows what was added.
    real_collector = api_module._collect_decision_evidence_pointers

    def _patched(*, study_id: str, scope: dict[str, Any], inputs_used: list[str]) -> list[str]:
        pointers = real_collector(
            study_id=study_id, scope=scope, inputs_used=inputs_used
        )
        return sorted(set(list(pointers) + ["new:pointer:added"]))

    monkeypatch.setattr(
        api_module, "_collect_decision_evidence_pointers", _patched
    )

    r = client.get(f"/decisions/{decision_id}/in-year")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "new:pointer:added" in body["diff"]["evidence_added"]
    assert body["diff"]["evidence_invalidated"] == []
    # Hashes differ since the evidence set shifted.
    assert (
        body["snapshot_hashes"]["evidence_hash"]
        != body["current_hashes"]["evidence_hash"]
    )
    # Pre-existing pointers still present → not invalidated.
    for p in original_pointers:
        assert p not in body["diff"]["evidence_invalidated"]


def test_in_year_diff_detects_invalidated_pointer_after_commit(
    isolated_dagster_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Drop an originally-present pointer; the diff must mark it invalidated."""
    client = TestClient(app)
    commit = _commit_decision(client)
    decision_id = commit["decision_id"]
    original_pointers = list(commit["snapshot"]["evidence_pointers"])
    assert original_pointers, "decision snapshot must seed with pointers"
    to_drop = original_pointers[0]

    real_collector = api_module._collect_decision_evidence_pointers

    def _patched(*, study_id: str, scope: dict[str, Any], inputs_used: list[str]) -> list[str]:
        pointers = real_collector(
            study_id=study_id, scope=scope, inputs_used=inputs_used
        )
        return sorted(p for p in pointers if p != to_drop)

    monkeypatch.setattr(
        api_module, "_collect_decision_evidence_pointers", _patched
    )

    r = client.get(f"/decisions/{decision_id}/in-year")
    assert r.status_code == 200, r.text
    body = r.json()
    assert to_drop in body["diff"]["evidence_invalidated"]
    assert body["diff"]["evidence_added"] == []


def test_in_year_diff_404_for_unknown_decision(
    isolated_dagster_home: Path,
) -> None:
    client = TestClient(app)
    r = client.get("/decisions/does-not-exist/in-year")
    assert r.status_code == 404


def test_get_decision_returns_persisted_payload(
    isolated_dagster_home: Path,
) -> None:
    """The ``GET /decisions/{id}`` companion helper round-trips the asset."""
    client = TestClient(app)
    commit = _commit_decision(client)
    decision_id = commit["decision_id"]
    r = client.get(f"/decisions/{decision_id}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["decision_id"] == decision_id
    assert body["snapshot"]["evidence_hash"] == commit["snapshot"]["evidence_hash"]

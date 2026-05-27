"""Contract tests for the MBP decision-loop assets.

Covers the M2 surface in :mod:`diageo_research.granular_assets` plus
the FastAPI endpoints in :mod:`diageo_research.web.api`:

1. Asset-key determinism — same (scope + content) → same content id +
   asset key, regardless of when/where the asset is built.
2. Round-trip persistence — write one of each asset, read it back, and
   confirm the on-disk JSON equals the in-memory shape.
3. ``GET /studies/{id}/growth-drivers`` returns ``illustrative=false``
   for the Crown Peach tailgate driver (the only seeded driver wired
   to real BLS/TTB pointers).
4. ``POST /counterfactuals``, ``POST /decisions`` and ``POST /tasks``
   persist + materialize and return the content-addressed id.

In-year query diff semantics live in
:mod:`tests.test_inyear_query` — keeping them separate so each test
file matches one of the M5 contract surfaces.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from diageo_research.granular_assets import (
    COUNTERFACTUAL_ASSET_PREFIX,
    CounterfactualAsset,
    DECISION_ASSET_PREFIX,
    DecisionAsset,
    GROWTH_DRIVER_ASSET_PREFIX,
    GrowthDriverAsset,
    IN_YEAR_QUERY_ASSET_PREFIX,
    InYearQueryAsset,
    TASK_ASSET_PREFIX,
    TaskAsset,
    compute_decision_in_year_diff,
    compute_decision_snapshot,
    content_id_counterfactual,
    content_id_decision,
    content_id_in_year_query,
    content_id_task,
    counterfactual_asset_key,
    decision_asset_key,
    growth_driver_asset_key,
    in_year_query_asset_key,
    list_persisted_assets,
    load_decision_asset,
    persist_decision_asset,
    task_asset_key,
)
from diageo_research.web.api import app


@pytest.fixture()
def isolated_dagster_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> Path:
    """Point ``DAGSTER_HOME`` at a tmp dir so the API's emit path runs
    against a throwaway SQLite instance for the duration of the test."""
    monkeypatch.setenv("DAGSTER_HOME", str(tmp_path / "dagster_home"))
    return tmp_path


# =========================================================== Key determinism


def test_growth_driver_asset_key_is_deterministic() -> None:
    """Same (study_id, driver_id) → same key, regardless of when it's built."""
    a = growth_driver_asset_key(study_id="study_abc", driver_id="crown-peach-tailgate")
    b = growth_driver_asset_key(study_id="study_abc", driver_id="crown-peach-tailgate")
    assert a == b
    assert a[0] == GROWTH_DRIVER_ASSET_PREFIX
    assert len(a) == 3


def test_counterfactual_content_id_is_idempotent_on_content() -> None:
    """Identical scope + content → identical cf_id (and asset key)."""
    scope = {"study_id": "study_abc", "driver_id": "crown-peach-tailgate"}
    common = dict(
        study_id="study_abc",
        scope=scope,
        prompt="What if we lift tailgate spend 10%?",
        variants=[{"name": "baseline"}, {"name": "shift_to_peach"}],
        inputs=["bls:CUUR0000SEFW01", "ttb:monthly"],
        confidence_per_variant=[{"label": "Medium"}, {"label": "Low"}],
        assumes=["tailgate uplift carries year-round"],
        does_not_assume=["sponsor exclusivity"],
    )
    id1 = content_id_counterfactual(**common)
    id2 = content_id_counterfactual(**common)
    assert id1 == id2
    # The asset key must also be stable.
    k1 = counterfactual_asset_key(study_id="study_abc", cf_id=id1)
    k2 = counterfactual_asset_key(study_id="study_abc", cf_id=id2)
    assert k1 == k2
    assert k1[0] == COUNTERFACTUAL_ASSET_PREFIX


def test_counterfactual_content_id_invalidated_when_prompt_changes() -> None:
    """Any change to scope or content yields a different cf_id."""
    scope = {"study_id": "study_abc", "driver_id": "crown-peach-tailgate"}
    base = dict(
        study_id="study_abc",
        scope=scope,
        prompt="Original prompt.",
        variants=[],
        inputs=[],
        confidence_per_variant=[],
        assumes=[],
        does_not_assume=[],
    )
    id1 = content_id_counterfactual(**base)
    id2 = content_id_counterfactual(**{**base, "prompt": "Edited prompt."})
    assert id1 != id2


def test_decision_content_id_invariant_to_ref_ordering() -> None:
    """``counterfactual_refs`` is set-like — order must not change the id."""
    scope = {"study_id": "study_abc", "driver_id": "crown-peach-tailgate"}
    common = dict(
        scope=scope,
        recommendation="Lean tailgate spend into Crown Peach in NFL markets.",
        fragile_assumption="If Peach cannibalizes flagship.",
        inputs_used=["bls:CUUR0000SA0"],
        owner="maya",
        committed_at="2026-05-27T10:00:00+00:00",
    )
    id_a = content_id_decision(
        counterfactual_refs=["cf1", "cf2", "cf3"], **common
    )
    id_b = content_id_decision(
        counterfactual_refs=["cf3", "cf1", "cf2"], **common
    )
    assert id_a == id_b


def test_decision_asset_key_uses_decision_id_tail() -> None:
    k = decision_asset_key(study_id="study_abc", decision_id="abc123")
    assert k[0] == DECISION_ASSET_PREFIX
    assert k[-1] == "abc123"


def test_in_year_query_key_uses_decision_namespace() -> None:
    k = in_year_query_asset_key(decision_id="dec123", query_id="q456")
    assert k[0] == IN_YEAR_QUERY_ASSET_PREFIX
    assert k[-1] == "q456"


def test_task_asset_key_uses_scope_namespace() -> None:
    tid = content_id_task(
        kind="validate-promo",
        scope={"study_id": "study_abc", "driver_id": "crown-peach-tailgate"},
        description="Pull promo-data lift for tailgate occasions",
        due_date="2026-09-30",
        created_at="2026-05-27T10:00:00+00:00",
    )
    k = task_asset_key(scope_id="study_abc", task_id=tid)
    assert k[0] == TASK_ASSET_PREFIX
    assert k[-1] == tid


# =========================================================== Round-trip persist


def test_growth_driver_asset_round_trips_through_disk(
    isolated_dagster_home: Path,
) -> None:
    """Write a GrowthDriverAsset, read it back, confirm equality."""
    asset = GrowthDriverAsset(
        driver_id="crown-peach-tailgate",
        study_id="study_test",
        must_do="tailgating",
        driver_name="Crown Peach tailgate",
        hypotheses=["h1", "h2"],
        fragile_assumption="If Peach cannibalizes flagship.",
        evidence_pointers=["citation:bls:CUUR0000SA0"],
        markets=["Green Bay", "Nashville"],
        confidence_pill="Medium (71%)",
        illustrative=False,
        confidence_value=71,
    )
    payload = asset.to_dict()
    persist_decision_asset(
        GROWTH_DRIVER_ASSET_PREFIX,
        id_value=asset.driver_id,
        payload=payload,
    )
    loaded = load_decision_asset(GROWTH_DRIVER_ASSET_PREFIX, asset.driver_id)
    assert loaded == payload
    # Round-trip through the dataclass too — equality on critical fields.
    rebuilt = GrowthDriverAsset.from_dict(loaded)  # type: ignore[arg-type]
    assert rebuilt.illustrative is False
    assert rebuilt.evidence_pointers == ["citation:bls:CUUR0000SA0"]
    assert rebuilt.confidence_value == 71


def test_counterfactual_asset_round_trips_through_disk(
    isolated_dagster_home: Path,
) -> None:
    cf = CounterfactualAsset(
        cf_id="abc123def456",
        scope={"study_id": "study_test", "driver_id": "crown-peach-tailgate"},
        prompt="Stress-test tailgate spend.",
        variants=[{"name": "baseline"}, {"name": "peach-lean"}],
        inputs=["bls:CUUR0000SEFW01"],
        confidence_per_variant=[{"label": "Medium"}, {"label": "Low"}],
        assumes=["tailgate uplift carries year-round"],
        does_not_assume=["sponsor exclusivity"],
        study_id="study_test",
        created_at="2026-05-27T10:00:00+00:00",
    )
    payload = cf.to_dict()
    persist_decision_asset(
        COUNTERFACTUAL_ASSET_PREFIX, id_value=cf.cf_id, payload=payload
    )
    loaded = load_decision_asset(COUNTERFACTUAL_ASSET_PREFIX, cf.cf_id)
    assert loaded is not None
    assert loaded["cf_id"] == cf.cf_id
    assert loaded["prompt"] == cf.prompt
    assert loaded["variants"] == [{"name": "baseline"}, {"name": "peach-lean"}]


def test_decision_asset_round_trips_through_disk(
    isolated_dagster_home: Path,
) -> None:
    snap = compute_decision_snapshot(
        study_id="study_test",
        evidence_pointers=["bls:CUUR0000SA0", "ttb:monthly"],
        claim_ids=["claim_handle_1", "claim_handle_2"],
        curve_bytes=b"{}",
    )
    decision = DecisionAsset(
        decision_id="decid0001",
        scope={"study_id": "study_test", "driver_id": "crown-peach-tailgate"},
        recommendation="Lean tailgate spend into Crown Peach.",
        confidence={
            "sentence": "Holds in 8 of 10 framings.",
            "holds_in": 8,
            "of": 10,
            "label": "Medium",
        },
        fragile_assumption="If Peach cannibalizes flagship.",
        counterfactual_refs=["abc123def456"],
        inputs_used=["bls:CUUR0000SA0"],
        owner="maya",
        committed_at="2026-05-27T10:00:00+00:00",
        snapshot=snap,
    )
    persist_decision_asset(
        DECISION_ASSET_PREFIX,
        id_value=decision.decision_id,
        payload=decision.to_dict(),
    )
    loaded = load_decision_asset(DECISION_ASSET_PREFIX, decision.decision_id)
    assert loaded == decision.to_dict()


def test_task_asset_round_trips_through_disk(
    isolated_dagster_home: Path,
) -> None:
    task = TaskAsset(
        task_id="taskid0001",
        kind="validate-promo",
        scope={"study_id": "study_test", "driver_id": "crown-peach-tailgate"},
        description="Pull promo-data lift for tailgate occasions Q3.",
        created_at="2026-05-27T10:00:00+00:00",
        due_date="2026-09-30",
    )
    payload = task.to_dict()
    persist_decision_asset(
        TASK_ASSET_PREFIX, id_value=task.task_id, payload=payload
    )
    loaded = load_decision_asset(TASK_ASSET_PREFIX, task.task_id)
    assert loaded == payload
    # Listing helper returns the file we just wrote.
    listed = list_persisted_assets(TASK_ASSET_PREFIX)
    assert any(p["task_id"] == "taskid0001" for p in listed)


# =================================================================== API: GET


def test_get_study_growth_drivers_returns_seed_with_illustrative_flags(
    isolated_dagster_home: Path,
) -> None:
    """The Crown Royal NFL seed must hydrate with the right illustrative flags.

    Only ``crown-peach-tailgate`` should come back with
    ``illustrative=False`` — it's the single driver wired to real
    BLS / TTB evidence pointers. Every other driver in the seed stays
    illustrative so the FE renders an explicit chip.
    """
    client = TestClient(app)
    r = client.get("/studies/study_test/growth-drivers")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["study_id"] == "study_test"
    drivers = body["drivers"]
    assert drivers, "growth-driver seed should not return empty"
    by_id = {d["driver_id"]: d for d in drivers}
    assert "crown-peach-tailgate" in by_id
    assert by_id["crown-peach-tailgate"]["illustrative"] is False
    # Real-evidence driver carries non-empty pointers and they look like
    # the BLS / TTB identifiers we promised to wire.
    pointers = by_id["crown-peach-tailgate"]["evidence_pointers"]
    assert any("CUUR0000SA0" in p or "CUUR0000SEFW01" in p for p in pointers)
    assert any("ttb" in p.lower() for p in pointers)
    # Every other driver in the seed must declare illustrative=true.
    for did, d in by_id.items():
        if did == "crown-peach-tailgate":
            continue
        assert d["illustrative"] is True, f"{did} should be illustrative"
    # Must-Dos round-trip too.
    must_do_ids = {m["id"] for m in body["must_dos"]}
    assert {"gameday", "tailgating", "hosting"}.issubset(must_do_ids)


def test_get_study_growth_drivers_stamps_study_id_into_each_driver(
    isolated_dagster_home: Path,
) -> None:
    """Each returned driver carries the requested study_id (cross-study reuse)."""
    client = TestClient(app)
    r1 = client.get("/studies/study_a/growth-drivers")
    r2 = client.get("/studies/study_b/growth-drivers")
    assert r1.status_code == r2.status_code == 200
    for d in r1.json()["drivers"]:
        assert d["study_id"] == "study_a"
    for d in r2.json()["drivers"]:
        assert d["study_id"] == "study_b"


# ================================================================ API: POST


def test_post_counterfactual_persists_and_returns_content_id(
    isolated_dagster_home: Path,
) -> None:
    client = TestClient(app)
    body = {
        "study_id": "study_test",
        "scope": {
            "study_id": "study_test",
            "driver_id": "crown-peach-tailgate",
            "finding_id": None,
        },
        "prompt": "Stress-test tailgate spend split.",
        "variants": [{"name": "baseline"}, {"name": "peach-lean"}],
        "inputs": ["bls:CUUR0000SEFW01"],
        "confidence_per_variant": [
            {"label": "Medium"},
            {"label": "Low"},
        ],
        "assumes": ["tailgate uplift carries year-round"],
        "does_not_assume": ["sponsor exclusivity"],
    }
    r1 = client.post("/counterfactuals", json=body)
    assert r1.status_code == 200, r1.text
    payload1 = r1.json()
    assert payload1["cf_id"]
    assert payload1["asset_key"][0] == COUNTERFACTUAL_ASSET_PREFIX

    # Idempotent on identical content.
    r2 = client.post("/counterfactuals", json=body)
    assert r2.status_code == 200
    assert r2.json()["cf_id"] == payload1["cf_id"]

    # File landed on disk under runs/counterfactuals/.
    on_disk = load_decision_asset(COUNTERFACTUAL_ASSET_PREFIX, payload1["cf_id"])
    assert on_disk is not None
    assert on_disk["prompt"] == body["prompt"]


def test_post_decision_persists_with_snapshot_block(
    isolated_dagster_home: Path,
) -> None:
    client = TestClient(app)
    body = {
        "scope": {
            "study_id": "study_test",
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
    payload = r.json()
    assert payload["decision_id"]
    assert payload["asset_key"][0] == DECISION_ASSET_PREFIX

    snapshot = payload["snapshot"]
    for h in ("evidence_hash", "claims_hash", "curve_hash"):
        assert h in snapshot and isinstance(snapshot[h], str) and snapshot[h]
    # Snapshot reflects the merged evidence-pointer set (driver pointers + inputs_used).
    assert "bls:CUUR0000SA0" in snapshot["evidence_pointers"]
    # And the on-disk JSON carries the same shape.
    on_disk = load_decision_asset(DECISION_ASSET_PREFIX, payload["decision_id"])
    assert on_disk is not None
    assert on_disk["recommendation"] == body["recommendation"]
    assert on_disk["snapshot"]["evidence_hash"] == snapshot["evidence_hash"]


def test_post_decision_requires_study_id_in_scope(
    isolated_dagster_home: Path,
) -> None:
    """Missing study_id is a 422 from pydantic, not a 500 from the body."""
    client = TestClient(app)
    body = {
        "scope": {"driver_id": "crown-peach-tailgate"},  # missing study_id
        "recommendation": "anything",
        "confidence": {
            "sentence": "x",
            "holds_in": 1,
            "of": 1,
            "label": "Low",
        },
        "owner": "maya",
    }
    r = client.post("/decisions", json=body)
    assert r.status_code in (400, 422), r.text


def test_post_task_persists_and_returns_task_id(
    isolated_dagster_home: Path,
) -> None:
    client = TestClient(app)
    body = {
        "kind": "validate-promo",
        "scope": {
            "study_id": "study_test",
            "driver_id": "crown-peach-tailgate",
        },
        "due_date": "2026-09-30",
        "description": "Pull promo-data lift for Crown Peach tailgate Q3 2026.",
    }
    r = client.post("/tasks", json=body)
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["task_id"]
    assert payload["asset_key"][0] == TASK_ASSET_PREFIX
    assert payload["status"] == "open"
    on_disk = load_decision_asset(TASK_ASSET_PREFIX, payload["task_id"])
    assert on_disk is not None
    assert on_disk["description"] == body["description"]

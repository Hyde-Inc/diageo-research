"""Contract tests for the ``/assets/*`` read-path endpoints.

The endpoints surface persistent-Dagster-instance state to the FE.
This file pins their request / response shapes — what URL parts are
b64 asset keys, what fields the JSON bodies carry, and what error
codes they return — so the FE can build against a stable contract.

All tests use ``DagsterInstance.ephemeral()`` via the
``_resolve_dagster_instance`` shim so we never touch a real
``.dagster_home``. The ``ephemeral`` path falls back automatically when
``DAGSTER_HOME`` is unset and no ``.dagster_home`` directory exists.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest
from dagster import AssetMaterialization, DagsterInstance
from fastapi.testclient import TestClient

from diageo_research import keys
from diageo_research.dagster_assets import (
    RESEARCH_CELL_PARTITIONS,
    emit_cell_materialization,
)
from diageo_research.orchestrator import _resolve_dagster_instance
from diageo_research.web.api import app


REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture()
def isolated_instance(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Any:
    """Point Dagster at a throwaway DAGSTER_HOME for this test.

    The API endpoints call :func:`_resolve_dagster_instance`, which
    reads ``DAGSTER_HOME``. We monkeypatch it to a tmp dir so this
    test doesn't see (or write into) the developer's real instance.
    """
    monkeypatch.setenv("DAGSTER_HOME", str(tmp_path))
    yield tmp_path


def _seed_cell_event(
    dagster_home: Path,
    *,
    question: str = "Smoke question",
    axes: dict[str, str] | None = None,
    status: str = "complete",
    wall_time_s: float = 12.3,
) -> str:
    """Drop one runless ``research_cell`` event into the persistent instance.

    Returns the encoded asset key for the seeded event so the test can
    GET it back. Uses :func:`emit_cell_materialization` so the metadata
    bundle exactly matches what production writes. Routes through
    :func:`_resolve_dagster_instance` so the seed and the read path
    share an identical SQLite configuration (avoids a subtle "default
    instance vs configured instance" split).
    """
    instance = _resolve_dagster_instance()
    try:
        run_dir = dagster_home / "runs_dir_simulated_run"
        run_dir.mkdir(parents=True, exist_ok=True)
        payload = emit_cell_materialization(
            instance,
            question=question,
            axes=axes,
            run_dir=run_dir,
            status=status,
            wall_time_s=wall_time_s,
        )
        return keys.encode_asset_key(payload["asset_key_path"])
    finally:
        instance.dispose()


# ----------------------------------------------------------------- GET /assets


def test_get_assets_lists_seeded_cells(isolated_instance: Path) -> None:
    """Newly emitted cell materializations show up in the listing."""
    _seed_cell_event(
        isolated_instance,
        question="What is happening with prices?",
        axes={"lens": "demand_space"},
    )
    client = TestClient(app)
    r = client.get("/assets")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "assets" in body
    assert "partition_sets" in body
    # The cell row is keyed by ["research_cell", question_hash, axes_signature].
    cell_rows = [a for a in body["assets"] if a.get("kind") == "cell"]
    assert len(cell_rows) >= 1
    row = cell_rows[0]
    assert row["asset_key"][0] == "research_cell"
    assert len(row["asset_key"]) == 3
    assert row["asset_key_encoded"]  # non-empty
    # Metadata carries the hashes so the FE can show a "same as 2 days ago?"
    # tooltip without re-decoding the partition key.
    assert "question_hash" in row["metadata"]
    assert "axes_signature" in row["metadata"]
    assert "cell_signature" in row["metadata"]


# ----------------------------------------------------------- GET /assets/{key}


def test_get_asset_detail_returns_latest_materialization(
    isolated_instance: Path,
) -> None:
    """``GET /assets/{key}`` returns latest + recent for one asset key."""
    key_b64 = _seed_cell_event(
        isolated_instance,
        question="Detail view test question.",
        axes={"lens": "cohort", "cohort": "sub60k"},
    )
    client = TestClient(app)
    r = client.get(f"/assets/{key_b64}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["asset_key_encoded"] == key_b64
    assert body["asset_key"][0] == "research_cell"
    assert body["latest"] is not None
    assert body["latest"]["partition_key"]  # cell signature lives here
    assert body["lineage"]["upstream"]  # research_cell synthesises from synthesis


def test_get_asset_detail_404_on_bad_key() -> None:
    """Malformed base64 asset keys return 400."""
    client = TestClient(app)
    r = client.get("/assets/not!a@valid#key")
    assert r.status_code == 400


# ----------------------------------------------- GET /assets/{key}/lineage


def test_get_asset_lineage_for_declared_stage() -> None:
    """Declared stage assets surface their declared upstream / downstream."""
    client = TestClient(app)
    key_b64 = keys.encode_asset_key(["synthesis"])
    r = client.get(f"/assets/{key_b64}/lineage")
    assert r.status_code == 200, r.text
    body = r.json()
    # synthesis depends on outline + interviews + verifier.
    upstream_paths = [entry["asset_key"] for entry in body["upstream"]]
    upstream_leaves = {p[-1] for p in upstream_paths if p}
    assert {"outline", "interviews", "verifier"}.issubset(upstream_leaves)


def test_get_asset_lineage_for_research_cell_points_at_synthesis() -> None:
    """Content-addressed cell briefs trace back to synthesis."""
    client = TestClient(app)
    key_b64 = keys.encode_asset_key(["research_cell", "abc", "xyz"])
    r = client.get(f"/assets/{key_b64}/lineage")
    assert r.status_code == 200, r.text
    body = r.json()
    upstream_leaves = {entry["asset_key"][-1] for entry in body["upstream"]}
    assert "synthesis" in upstream_leaves


# ------------------------------------------------ GET /assets/{key}/history


def test_get_asset_history_returns_recent_materializations(
    isolated_instance: Path,
) -> None:
    """Repeated emissions accumulate in the history list."""
    key_b64 = _seed_cell_event(
        isolated_instance,
        question="History test question.",
        axes={"lens": "alpha"},
        wall_time_s=1.0,
    )
    # Second emission against the same key — same partition.
    _seed_cell_event(
        isolated_instance,
        question="History test question.",
        axes={"lens": "alpha"},
        wall_time_s=2.5,
    )
    client = TestClient(app)
    r = client.get(f"/assets/{key_b64}/history?limit=5")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["asset_key_encoded"] == key_b64
    assert len(body["history"]) >= 2
    # History is newest-first; timestamps must be monotonic descending.
    timestamps = [row["timestamp"] for row in body["history"]]
    assert timestamps == sorted(timestamps, reverse=True)


# ------------------------------------------------ POST /assets/{key}/materialize


def test_post_materialize_rejects_stage_assets(isolated_instance: Path) -> None:
    """Re-materialising a declared stage asset directly is refused."""
    client = TestClient(app)
    key_b64 = keys.encode_asset_key(["question_analysis"])
    r = client.post(
        f"/assets/{key_b64}/materialize",
        json={"question": "anything", "axes": {}},
    )
    assert r.status_code == 400
    assert "research_cell" in r.text


def test_post_materialize_research_cell_requires_question(
    isolated_instance: Path,
) -> None:
    """We need the original question text to rebuild the stage context."""
    client = TestClient(app)
    key_b64 = keys.encode_asset_key(["research_cell", "abc", "xyz"])
    r = client.post(f"/assets/{key_b64}/materialize", json={})
    assert r.status_code == 400
    assert "question" in r.text.lower()

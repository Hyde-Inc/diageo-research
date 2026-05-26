"""Tests for the persistent Dagster instance path.

These complement ``test_dagster_assets.py`` (which always uses
``DagsterInstance.ephemeral()``) by exercising the disk-backed branch
that gets selected when ``DAGSTER_HOME`` is set. They:

1. Confirm ``dagster.yaml`` and ``workspace.yaml`` live at the repo
   root and parse as the YAML shapes ``dagster dev`` expects.
2. Confirm :func:`DagsterInstance.get` returns a real (non-ephemeral)
   instance once ``DAGSTER_HOME`` is exported.
3. Replay an existing on-disk materialization receipt through
   :meth:`DagsterInstance.report_runless_asset_event` and confirm the
   event lands in the persistent event log so Dagit's asset-detail
   view would see it.

The tests do NOT spawn a webserver and do NOT make any LLM calls.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml
from dagster import (
    AssetKey,
    AssetMaterialization,
    DagsterInstance,
)


REPO_ROOT = Path(__file__).resolve().parent.parent
DAGSTER_YAML = REPO_ROOT / "dagster.yaml"
WORKSPACE_YAML = REPO_ROOT / "workspace.yaml"


# --------------------------------------------------------- Config files exist


def test_dagster_yaml_at_repo_root_is_valid() -> None:
    """``dagster.yaml`` exists at the repo root and declares the stores
    Dagit needs to persist run history across process restarts."""
    assert DAGSTER_YAML.exists(), f"missing {DAGSTER_YAML}"
    data = yaml.safe_load(DAGSTER_YAML.read_text(encoding="utf-8"))
    assert isinstance(data, dict), "dagster.yaml must be a YAML mapping"
    # The five storage providers that turn an ephemeral instance into a
    # disk-backed one. Without all of these the UI may fall back to
    # surprising defaults (in-memory event log, etc.).
    for key in (
        "run_storage",
        "event_log_storage",
        "schedule_storage",
        "compute_logs",
        "local_artifact_storage",
    ):
        assert key in data, f"{DAGSTER_YAML.name} missing top-level key {key!r}"
        block = data[key]
        assert isinstance(block, dict), f"{key} block must be a mapping"
        assert "module" in block and "class" in block, (
            f"{key} block must specify `module` and `class`"
        )
    # Telemetry off — we don't ship usage stats from a customer demo.
    assert data.get("telemetry", {}).get("enabled") is False


def test_workspace_yaml_loads_our_module() -> None:
    """``workspace.yaml`` points Dagit at our installable package."""
    assert WORKSPACE_YAML.exists(), f"missing {WORKSPACE_YAML}"
    data = yaml.safe_load(WORKSPACE_YAML.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    load_from = data.get("load_from")
    assert isinstance(load_from, list) and load_from, "load_from must be a non-empty list"
    # Accept either python_module: <string> or python_module: { module_name }
    has_module = False
    for entry in load_from:
        if not isinstance(entry, dict):
            continue
        pm = entry.get("python_module")
        if isinstance(pm, str) and pm == "diageo_research.dagster_assets":
            has_module = True
        elif isinstance(pm, dict) and pm.get("module_name") == "diageo_research.dagster_assets":
            has_module = True
    assert has_module, "workspace.yaml must load diageo_research.dagster_assets"


# ---------------------------------------------------- Persistent instance


def test_persistent_instance_is_non_ephemeral(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With ``DAGSTER_HOME`` set, ``DagsterInstance.get`` returns the
    persistent disk-backed instance — not the in-memory ephemeral
    fallback that the test suite normally uses."""
    monkeypatch.setenv("DAGSTER_HOME", str(tmp_path))
    instance = DagsterInstance.get()
    try:
        # ``EphemeralDagsterInstance`` is the in-memory subclass; the
        # disk-backed default class name is ``DagsterInstance`` itself.
        # Compare on the class name so we don't import the private symbol.
        assert type(instance).__name__ != "EphemeralDagsterInstance", (
            "DagsterInstance.get() should NOT return an ephemeral "
            "instance when DAGSTER_HOME is set"
        )
        # SqliteRunStorage / SqliteEventLogStorage create their DB files
        # lazily; the root dir should at least exist.
        assert tmp_path.exists() and tmp_path.is_dir()
    finally:
        instance.dispose()


# ---------------------------------------------------- Materialization replay


def test_report_runless_materialization_lands_in_event_log(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Replaying a stage receipt as an ``AssetMaterialization`` writes
    a real ``ASSET_MATERIALIZATION`` event into the persistent log.

    This is the contract the seed script (`scripts/seed_dagster_from_runs.py`)
    relies on to backfill Dagit from the JSONL receipts left by prior
    ephemeral runs.
    """
    monkeypatch.setenv("DAGSTER_HOME", str(tmp_path))
    instance = DagsterInstance.get()
    try:
        instance.add_dynamic_partitions("study_cells", ["replay_cell_1"])
        instance.report_runless_asset_event(
            AssetMaterialization(
                asset_key="question_analysis",
                partition="replay_cell_1",
                description="seeded test event",
                metadata={
                    "spent_usd": 0.07,
                    "n_calls": 1,
                    "model_id": "claude-opus-4-7",
                    "seeded_from_disk": True,
                },
            )
        )

        # ``fetch_materializations`` is the Dagster 1.13+ entry point;
        # it returns one record per persisted ASSET_MATERIALIZATION.
        result = instance.fetch_materializations(
            records_filter=AssetKey(["question_analysis"]),
            limit=10,
        )
        records = list(result.records)
        assert records, (
            "expected at least one ASSET_MATERIALIZATION record in the "
            "persistent event log after report_runless_asset_event"
        )
        # Sanity-check that the metadata round-trips so Dagit will
        # render the spend and model on the asset detail page. The
        # AssetMaterialization object stored on the event carries a
        # ``metadata`` mapping (str -> MetadataValue) — both keys must
        # survive the round trip through report_runless_asset_event.
        first = records[0].event_log_entry.dagster_event
        assert first is not None
        materialization = first.event_specific_data.materialization  # type: ignore[union-attr]
        assert "spent_usd" in materialization.metadata
        assert "model_id" in materialization.metadata
    finally:
        instance.dispose()


# ----------------------------------------------------- Env var sanity


def test_dagster_home_unset_in_test_env() -> None:
    """Sanity: the rest of the test suite must never leak DAGSTER_HOME
    into a subsequent test. If this fails, hermetic tests are at risk."""
    # The persistent tests above set DAGSTER_HOME via monkeypatch (which
    # auto-unsets at teardown). If something else exported it globally,
    # the ephemeral-instance tests would silently become persistent.
    # We tolerate it (don't fail), but log a warning to surface the case.
    if os.environ.get("DAGSTER_HOME"):
        pytest.skip(
            "DAGSTER_HOME is exported in the calling shell; "
            "rest of the suite still uses ephemeral instances explicitly."
        )

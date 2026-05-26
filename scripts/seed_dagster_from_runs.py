#!/usr/bin/env python
"""Seed the persistent Dagster instance from existing runs/.

Background
----------
Before we wired up a persistent ``DagsterInstance``, every cell was
materialized through ``DagsterInstance.ephemeral()`` — so the canonical
record of a materialization is the on-disk JSONL receipt at
``runs/<run_id>/dagster_materializations.jsonl`` (one row per stage,
written from :func:`diageo_research.dagster_assets._record_materialization`).
Those receipts contain everything Dagit needs to display a real
``AssetMaterialization`` event: model id, spend, n_calls, input/output
hashes, elapsed time, plus stage-specific counts.

This script reads each ``dagster_materializations.jsonl`` under
``runs/`` and replays the rows as :class:`AssetMaterialization` events
into the persistent instance via :meth:`DagsterInstance.report_runless_asset_event`.
After running it once, ``diageo dagster-dev`` will show the same
material­izations the FE workbench already shows from disk — without
re-spending any LLM dollars.

Usage
-----
::

    DAGSTER_HOME=$(pwd)/.dagster_home uv run \
        python scripts/seed_dagster_from_runs.py

Or, equivalently, from the activated venv::

    DAGSTER_HOME=$(pwd)/.dagster_home python scripts/seed_dagster_from_runs.py

It's idempotent in the sense that re-running it will append duplicate
events to Dagit (Dagster doesn't dedupe runless events). Use
``--dry-run`` first if you're not sure how many rows are about to land.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
from pathlib import Path
from typing import Any

# Allow `python scripts/seed_dagster_from_runs.py` from the repo root
# without `pip install -e .` having been run; importable via ``src/``
# layout already, since the project is editable-installed by uv.
ROOT = Path(__file__).resolve().parent.parent

# Stage-specific output keys we know how to render into Dagit metadata.
# Anything else in the receipt goes into a generic "extra" text node so
# we don't drop information silently.
_KNOWN_OUTPUT_KEYS_BY_STAGE: dict[str, list[str]] = {
    "question_analysis": ["complexity", "complexity_score", "recommended_personas"],
    "personas": ["n_personas"],
    "outline": ["n_sections"],
    "interviews": ["n_subreports", "total_citations"],
    "verifier": ["verified", "flagged"],
    "synthesis": ["n_sections", "n_citations", "markdown_len"],
}

_PROVENANCE_KEYS = (
    "spent_usd",
    "n_calls",
    "input_hash",
    "output_hash",
    "prompt_hash",
    "code_hash",
    "model_id",
    "elapsed_s",
)


def _build_metadata(row: dict[str, Any]) -> dict[str, Any]:
    """Translate one JSONL row to a Dagster metadata mapping.

    Dagster's raw-metadata coercion accepts native Python types (str,
    int, float, bool, dict, list), so we pass the values through
    untouched. ``MetadataValue`` wrappers are unnecessary for the
    simple types we emit.
    """
    md: dict[str, Any] = {}
    stage = row.get("stage") or row.get("asset_key") or ""
    for k in _PROVENANCE_KEYS:
        if k in row and row[k] is not None:
            md[k] = row[k]
    for k in _KNOWN_OUTPUT_KEYS_BY_STAGE.get(stage, []):
        if k in row and row[k] is not None:
            md[k] = row[k]
    if "timestamp" in row:
        md["origin_timestamp"] = row["timestamp"]
    md["seeded_from_disk"] = True
    return md


def _resolve_partition_set_keys(receipts: list[tuple[Path, list[dict[str, Any]]]]) -> set[str]:
    keys: set[str] = set()
    for _path, rows in receipts:
        for row in rows:
            pk = row.get("partition_key") or row.get("run_id")
            if pk:
                keys.add(str(pk))
    return keys


def _collect_receipts(runs_root: Path) -> list[tuple[Path, list[dict[str, Any]]]]:
    out: list[tuple[Path, list[dict[str, Any]]]] = []
    if not runs_root.exists():
        return out
    for path in sorted(runs_root.glob("*/dagster_materializations.jsonl")):
        rows: list[dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                # Best-effort; skip malformed lines but keep going.
                continue
        if rows:
            out.append((path, rows))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--runs-dir",
        type=Path,
        default=ROOT / "runs",
        help="Where to find existing runs (default: ./runs).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be seeded without touching the instance.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Only seed the first N runs (default: 0 = all).",
    )
    args = parser.parse_args(argv)

    if "DAGSTER_HOME" not in os.environ:
        print(
            "DAGSTER_HOME is not set. Export it before running, e.g.:",
            file=sys.stderr,
        )
        print(
            f"  DAGSTER_HOME={ROOT / '.dagster_home'} python {sys.argv[0]}",
            file=sys.stderr,
        )
        return 2

    from dagster import AssetMaterialization, DagsterInstance

    receipts = _collect_receipts(args.runs_dir)
    if args.limit > 0:
        receipts = receipts[: args.limit]
    if not receipts:
        print(f"No dagster_materializations.jsonl files under {args.runs_dir}.")
        return 0

    partition_keys = _resolve_partition_set_keys(receipts)
    total_rows = sum(len(rows) for _, rows in receipts)
    print(
        f"Found {len(receipts)} runs / {total_rows} events / "
        f"{len(partition_keys)} unique partition keys."
    )
    if args.dry_run:
        for path, rows in receipts:
            stages = ", ".join(r.get("stage", "?") for r in rows)
            print(f"  [DRY] {path.parent.name}: {stages}")
        return 0

    instance = DagsterInstance.get()
    # Register every partition key against the ``study_cells`` dynamic
    # partition set. Idempotent: add_dynamic_partitions only adds new ones.
    if partition_keys:
        instance.add_dynamic_partitions("study_cells", sorted(partition_keys))

    n_emitted = 0
    for path, rows in receipts:
        for row in rows:
            asset_key = row.get("asset_key") or row.get("stage")
            partition = row.get("partition_key") or row.get("run_id")
            if not asset_key or not partition:
                continue
            metadata = _build_metadata(row)
            metadata["source_file"] = str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)
            event = AssetMaterialization(
                asset_key=str(asset_key),
                partition=str(partition),
                description=(
                    f"Seeded from disk receipt at "
                    f"{path.relative_to(ROOT) if path.is_relative_to(ROOT) else path} "
                    f"(originally recorded {row.get('timestamp', 'unknown')})."
                ),
                metadata=metadata,
            )
            instance.report_runless_asset_event(event)
            n_emitted += 1

    print(
        f"Reported {n_emitted} runless AssetMaterialization events into "
        f"DAGSTER_HOME={os.environ['DAGSTER_HOME']} "
        f"at {_dt.datetime.now().isoformat(timespec='seconds')}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

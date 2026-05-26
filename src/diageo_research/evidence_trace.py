"""Evidence trace payloads for clickable numbers in the research brief."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import get_settings
from .manifest import read_manifest
from .multiverse import read_study
from .multiverse_report import build_spec_curve
from .run_writer import list_stage_files


@dataclass
class TraceStep:
    kind: str
    title: str
    detail: str
    asset_ref: str | None = None
    timestamp: str | None = None
    code_version: str | None = None
    prompt_version: str | None = None


@dataclass
class EvidenceTrace:
    trace_id: str
    label: str
    value_display: str
    steps: list[TraceStep] = field(default_factory=list)
    run_id: str | None = None
    cluster_id: int | None = None
    illustrative: bool = False


def _load_materializations(run_id: str) -> list[dict[str, Any]]:
    path = get_settings().runs_dir / run_id / "dagster_materializations.jsonl"
    out: list[dict[str, Any]] = []
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def build_evidence_trace(
    study_id: str,
    *,
    trace_id: str,
    cluster_id: int | None = None,
    run_id: str | None = None,
    metric: str | None = None,
) -> EvidenceTrace:
    study = read_study(study_id)
    if study is None:
        raise FileNotFoundError(f"No such study: {study_id}")
    settings = get_settings()
    curve = build_spec_curve(study_id)
    row = None
    if cluster_id is not None:
        row = next((r for r in curve.rows if r.cluster_id == cluster_id), None)

    source_cell = None
    if run_id:
        source_cell = next((c for c in study.cells if c.run_id == run_id), None)
    if source_cell is None and row:
        for c in study.cells:
            if row.statuses.get(c.id) == "agree":
                source_cell = c
                break
    if source_cell is None and study.cells:
        source_cell = next(
            (c for c in study.cells if c.status == "complete"),
            study.cells[0],
        )

    label = metric or trace_id
    value_display = trace_id
    steps: list[TraceStep] = []
    illustrative = source_cell is None or source_cell.status != "complete"

    if row and metric and metric.startswith("robustness"):
        value_display = f"{row.robustness:.0%}"
        label = "Robustness score"
    elif row and re.fullmatch(r"\d+", trace_id or ""):
        value_display = trace_id
        label = "Scenario agreement count"

    if source_cell:
        run_id = source_cell.run_id
        run_dir = settings.runs_dir / run_id
        manifest = read_manifest(run_dir)
        steps.append(
            TraceStep(
                kind="source",
                title="Source scenario brief",
                detail=(
                    f"Executive answer from scenario "
                    f"{source_cell.id.replace('__', ' · ')}."
                ),
                asset_ref=f"runs/{run_id}/final.md",
            )
        )
        for slug, path in list_stage_files(run_dir)[:6]:
            steps.append(
                TraceStep(
                    kind="transform",
                    title=f"Stage · {slug}",
                    detail=f"Markdown artefact ({path.stat().st_size} bytes).",
                    asset_ref=f"runs/{run_id}/stages/{slug}",
                    timestamp=(
                        manifest.started_at.isoformat() if manifest else None
                    ),
                    code_version=manifest.code_hash if manifest else None,
                )
            )
        for mat in _load_materializations(run_id):
            steps.append(
                TraceStep(
                    kind="materialization",
                    title=f"Dagster · {mat.get('stage', mat.get('asset_key', 'stage'))}",
                    detail=(
                        f"Partition {mat.get('partition_key', '—')} · "
                        f"model {mat.get('model_id', '—')}"
                    ),
                    asset_ref=f"runs/{run_id}/dagster_materializations.jsonl",
                    timestamp=mat.get("timestamp"),
                    code_version=mat.get("code_hash"),
                    prompt_version=mat.get("prompt_hash"),
                )
            )
        steps.append(
            TraceStep(
                kind="output",
                title="Output number",
                detail=label,
                asset_ref=f"runs/{run_id}/final.md",
            )
        )
    else:
        illustrative = True
        steps = [
            TraceStep(
                kind="source",
                title="Tagged source assets",
                detail="Spec curve and study briefs (illustrative until cells complete).",
                asset_ref=f"runs/{study_id}/spec_curve.json",
            ),
            TraceStep(
                kind="output",
                title="Output number",
                detail=label,
            ),
        ]

    return EvidenceTrace(
        trace_id=trace_id,
        label=label,
        value_display=value_display,
        steps=steps,
        run_id=run_id,
        cluster_id=cluster_id,
        illustrative=illustrative,
    )

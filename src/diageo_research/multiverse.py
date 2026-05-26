"""Multiverse orchestrator: same question, many defensible specifications.

Wraps the existing single-shot pipeline (`run_research` in
`orchestrator.py`) so it executes the same question across a grid of
specifications, persists per-cell run artefacts under unique run_ids, and
keeps a parent `study.json` with cell statuses for the workbench UI to
read.

The orchestrator itself does not change. Each cell calls `run_research`
with parameter overrides; cells are isolated via run_id, so failures in
one cell never poison another. The grid is defined in YAML (see
`samples/study_pricing_pressure.yaml`) and the contract is signed in
`prereg.yaml`.

Layout on disk:

    runs/
      study_<sid>/
        study.json            <- parent state (this module owns it)
        prereg.yaml           <- input, copied from spec
        spec_grid.yaml        <- input, copied from spec
        spec_curve.json/.md   <- written by multiverse_report.py
      <sid>_<cell_id>/         <- standard run dir, one per cell
        events.jsonl
        final.md / final.json
        stages/...

Cell ids are deterministic from the axis selections (e.g.
`demand_space__sub60k__post_inflation`), which makes the workbench
URL-shareable and the manifest replayable.
"""
from __future__ import annotations

import asyncio
import itertools
import json
import logging
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .config import get_settings
from .decision_brief import apply_prereg_to_brief
from .orchestrator import materialize_research_cell
from .prereg import PreReg, PreregError, load_prereg, write_prereg

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------- Models

CellStatus = Literal["pending", "running", "complete", "error"]
StudyStatus = Literal["pending", "running", "complete", "partial", "error"]


class AxisValue(BaseModel):
    """One value along a multiverse axis. Carries an addendum (free-text the
    runner appends to the question) and optional override knobs."""

    id: str = Field(..., min_length=1)
    label: str = ""
    addendum: str = ""
    overrides: dict[str, Any] = Field(default_factory=dict)


class Axis(BaseModel):
    """A multiverse axis (e.g. taxonomy framing, cohort cut, time window).
    Each axis has a name and >=1 candidate values; the cartesian product
    across axes generates the grid."""

    name: str = Field(..., min_length=1)
    label: str = ""
    description: str = ""
    values: list[AxisValue] = Field(..., min_length=1)


class Defaults(BaseModel):
    """Defaults applied to every cell unless overridden by an axis value.

    Cost guardrails:
    - ``enable_web_browse``: when False (recommended for unattended studies)
      the cell never spawns browser-use. Each browse step costs a Sonnet
      round-trip and the local Chromium path is unreliable against Google/
      .gov in headless. Default False at the spec level so unattended runs
      are safe by default.
    - ``max_browses_per_cell``: hard cap on ``web_browse`` calls across all
      personas/turns of one cell. Belt-and-braces with the master toggle.
    - ``max_cost_usd``: stops the cell when cumulative Anthropic spend
      crosses this number. Reads token usage off every call.
    """

    n_personas: int | None = Field(default=None, ge=1, le=8)
    max_turns: int | None = Field(default=None, ge=1, le=12)
    enable_web_browse: bool | None = None
    max_browses_per_cell: int | None = Field(default=None, ge=0, le=64)
    max_cost_usd: float | None = Field(default=None, ge=0)


class StudySpec(BaseModel):
    """The full study specification: question + prereg pointer + axes +
    defaults. Loaded from `samples/study_<name>.yaml`."""

    name: str = Field(..., min_length=1)
    question: str = Field(..., min_length=1)
    prereg: PreReg
    axes: list[Axis] = Field(..., min_length=1)
    defaults: Defaults = Field(default_factory=Defaults)
    concurrency: int = Field(
        default=2,
        ge=1,
        le=8,
        description="Cells in flight simultaneously. Mind your LLM rate limits.",
    )


class SpecCell(BaseModel):
    """One executed cell of the multiverse grid."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    id: str  # deterministic, axis-derived (e.g. "demand_space__sub60k__post_inflation")
    axes: dict[str, str]  # axis name -> selected value id
    addenda: list[str] = Field(default_factory=list)
    overrides: dict[str, Any] = Field(default_factory=dict)
    run_id: str = ""
    status: CellStatus = "pending"
    started_at: datetime | None = None
    finished_at: datetime | None = None
    elapsed_s: float | None = None
    error: str | None = None


class Study(BaseModel):
    """Parent state for a multiverse study. Persisted as `study.json`."""

    id: str
    name: str
    question: str
    cell_question_template: str = ""
    prereg_path: str
    spec_path: str
    cells: list[SpecCell]
    status: StudyStatus = "pending"
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(tz=timezone.utc)
    )
    started_at: datetime | None = None
    finished_at: datetime | None = None
    concurrency: int = 2


# ------------------------------------------------------------------- Loading


def new_study_id() -> str:
    return "study_" + uuid.uuid4().hex[:10]


def load_spec(path: Path) -> StudySpec:
    """Load and validate a study spec YAML."""
    if not path.exists():
        raise FileNotFoundError(f"study spec not found at {path}")
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    try:
        return StudySpec.model_validate(raw)
    except ValidationError as ve:
        raise ValueError(f"study spec at {path} failed validation:\n{ve}") from ve


def expand_grid(spec: StudySpec) -> list[SpecCell]:
    """Cartesian product over axes → list of SpecCell. Cell ids are joined
    axis-value ids; cell addenda are the per-axis addenda concatenated; cell
    overrides merge axis-value overrides (later axes win on key collision)."""
    axis_iters: list[list[tuple[Axis, AxisValue]]] = [
        [(ax, v) for v in ax.values] for ax in spec.axes
    ]
    cells: list[SpecCell] = []
    for combo in itertools.product(*axis_iters):
        cell_axes = {ax.name: val.id for ax, val in combo}
        cell_id = "__".join(val.id for _, val in combo)
        addenda = [v.addendum for _, v in combo if v.addendum]
        overrides: dict[str, Any] = {}
        # Spec-level defaults — axis values can override any of these.
        if spec.defaults.n_personas is not None:
            overrides["n_personas"] = spec.defaults.n_personas
        if spec.defaults.max_turns is not None:
            overrides["max_turns"] = spec.defaults.max_turns
        if spec.defaults.enable_web_browse is not None:
            overrides["enable_web_browse"] = spec.defaults.enable_web_browse
        if spec.defaults.max_browses_per_cell is not None:
            overrides["max_browses_per_cell"] = spec.defaults.max_browses_per_cell
        if spec.defaults.max_cost_usd is not None:
            overrides["max_cost_usd"] = spec.defaults.max_cost_usd
        for _, val in combo:
            overrides.update(val.overrides)
        cells.append(
            SpecCell(
                id=cell_id,
                axes=cell_axes,
                addenda=addenda,
                overrides=overrides,
            )
        )
    return cells


def render_cell_question(question: str, addenda: Iterable[str]) -> str:
    """Build the per-cell question string by appending the spec addenda as a
    single 'Spec framing' block. The orchestrator already handles arbitrary
    free-text questions, so this is a non-invasive override channel."""
    addenda = [a for a in addenda if a]
    if not addenda:
        return question
    framing = "\n\n## Spec framing for this cell\n" + "\n".join(
        f"- {a}" for a in addenda
    )
    return question + framing


# ---------------------------------------------------------------- Persistence


def study_dir(study_id: str) -> Path:
    return get_settings().runs_dir / study_id


def write_study(study: Study) -> None:
    """Atomically persist study.json under runs/<study_id>/."""
    out = study_dir(study.id)
    out.mkdir(parents=True, exist_ok=True)
    payload = study.model_dump(mode="json")
    tmp = out / ".study.json.tmp"
    final = out / "study.json"
    tmp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    tmp.replace(final)


def read_study(study_id: str) -> Study | None:
    path = study_dir(study_id) / "study.json"
    if not path.exists():
        return None
    try:
        return Study.model_validate_json(path.read_text(encoding="utf-8"))
    except ValidationError:
        return None


def list_studies() -> list[dict[str, Any]]:
    """Return summary rows for every study under runs/, newest first."""
    runs_dir = get_settings().runs_dir
    if not runs_dir.exists():
        return []
    out: list[dict[str, Any]] = []
    for p in sorted(
        (q for q in runs_dir.iterdir() if q.is_dir() and q.name.startswith("study_")),
        key=lambda x: x.stat().st_mtime,
        reverse=True,
    ):
        study = read_study(p.name)
        if study is None:
            continue
        n_complete = sum(1 for c in study.cells if c.status == "complete")
        n_error = sum(1 for c in study.cells if c.status == "error")
        out.append(
            {
                "id": study.id,
                "name": study.name,
                "question": study.question,
                "status": study.status,
                "n_cells": len(study.cells),
                "n_complete": n_complete,
                "n_error": n_error,
                "created_at": study.created_at.isoformat(),
            }
        )
    return out


# --------------------------------------------------------------------- Runner


async def run_study_from_spec_path(
    spec_path: Path,
    study_id: str | None = None,
) -> Study:
    """High-level entry point: load a spec YAML, validate prereg, fan out
    cells, return the final Study object once all cells finish (success or
    error). Per-cell artefacts live under standard run_dirs; the parent
    state is `runs/<study_id>/study.json`."""
    spec = load_spec(spec_path)
    return await run_study(spec, spec_path=spec_path, study_id=study_id)


async def run_study(
    spec: StudySpec,
    spec_path: Path | None = None,
    study_id: str | None = None,
) -> Study:
    """Execute a study from an in-memory spec (the API path uses this)."""
    settings = get_settings()
    sid = study_id or new_study_id()
    out = study_dir(sid)
    out.mkdir(parents=True, exist_ok=True)

    # Persist the spec + prereg under the study dir so the workbench can
    # render them and the manifest can hash a stable input.
    prereg_path = out / "prereg.yaml"
    write_prereg(prereg_path, spec.prereg)
    spec_path_local = out / "spec_grid.yaml"
    if spec_path is not None and spec_path.exists():
        shutil.copyfile(spec_path, spec_path_local)
    else:
        spec_path_local.write_text(
            yaml.safe_dump(spec.model_dump(mode="json"), sort_keys=False),
            encoding="utf-8",
        )

    cells = expand_grid(spec)
    for c in cells:
        c.run_id = f"{sid}_{c.id}"

    study = Study(
        id=sid,
        name=spec.name,
        question=spec.question,
        cell_question_template=spec.question,
        prereg_path=str(prereg_path),
        spec_path=str(spec_path_local),
        cells=cells,
        concurrency=spec.concurrency,
        status="running",
        started_at=datetime.now(tz=timezone.utc),
    )
    write_study(study)
    logger.info(
        "study %s started — %d cells across %d axes (concurrency=%d)",
        sid, len(cells), len(spec.axes), spec.concurrency,
    )

    # Cells are isolated via unique run_ids so we can fan them out without
    # cross-contaminating the existing per-run state in orchestrator.py.
    sem = asyncio.Semaphore(spec.concurrency)
    results = await asyncio.gather(
        *[_execute_cell(study, cell, spec, sem) for cell in cells],
        return_exceptions=True,
    )

    # Reconcile: gather() with return_exceptions=True only catches truly
    # uncaught exceptions; _execute_cell already records error states on
    # the cell object. The result list is order-aligned with cells.
    for cell, res in zip(cells, results):
        if isinstance(res, Exception) and cell.status not in ("error",):
            cell.status = "error"
            cell.error = repr(res)

    n_complete = sum(1 for c in cells if c.status == "complete")
    n_error = sum(1 for c in cells if c.status == "error")
    if n_error == len(cells):
        study.status = "error"
    elif n_error > 0:
        study.status = "partial"
    else:
        study.status = "complete"
    study.finished_at = datetime.now(tz=timezone.utc)
    write_study(study)
    logger.info(
        "study %s finished — status=%s (%d/%d complete, %d errors)",
        sid, study.status, n_complete, len(cells), n_error,
    )
    return study


async def _execute_cell(
    study: Study,
    cell: SpecCell,
    spec: StudySpec,
    sem: asyncio.Semaphore,
) -> SpecCell:
    """Run one multiverse cell. Mutates `cell` in place and rewrites
    study.json after every status transition so the workbench sees live
    progress."""
    async with sem:
        cell.status = "running"
        cell.started_at = datetime.now(tz=timezone.utc)
        write_study(study)

        cell_question = render_cell_question(study.question, cell.addenda)
        n_personas = cell.overrides.get("n_personas")
        max_turns = cell.overrides.get("max_turns")
        enable_web_browse = cell.overrides.get("enable_web_browse")
        max_browses_per_cell = cell.overrides.get("max_browses_per_cell")
        max_cost_usd = cell.overrides.get("max_cost_usd")

        t0 = time.monotonic()
        try:
            # Multiverse cells run through Dagster's executor so the
            # declared asset graph drives execution and each stage emits
            # an AssetMaterialization record. The single-run /research
            # endpoint still calls run_research() directly for back-compat
            # (no Dagster overhead for one-shot questions).
            await materialize_research_cell(
                question=cell_question,
                run_id=cell.run_id,
                n_personas=n_personas,
                max_turns=max_turns,
                enable_web_browse=enable_web_browse,
                max_browses_per_cell=max_browses_per_cell,
                max_cost_usd=max_cost_usd,
                axes=dict(cell.axes),
            )
            cell.status = "complete"
            cell.elapsed_s = round(time.monotonic() - t0, 1)
            logger.info(
                "study %s cell %s complete in %.1fs",
                study.id, cell.id, cell.elapsed_s,
            )
            # Decision-brief contract step 1: prepend the prereg block to
            # this cell's final.md so the brief carries the rule the answer
            # is being scored against. Best-effort; never fails the cell.
            try:
                cell_run_dir = get_settings().runs_dir / cell.run_id
                apply_prereg_to_brief(cell_run_dir, spec.prereg)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "prereg injection failed for cell %s (non-fatal)", cell.id
                )
        except Exception as e:  # noqa: BLE001
            cell.status = "error"
            cell.elapsed_s = round(time.monotonic() - t0, 1)
            cell.error = str(e)
            logger.exception("study %s cell %s failed", study.id, cell.id)
        finally:
            cell.finished_at = datetime.now(tz=timezone.utc)
            write_study(study)
        return cell


# ------------------------------------------------------- Validation helpers


async def rerun_study_cell(study_id: str, cell_id: str) -> str:
    """Re-materialize a single cell after a plan revision (proof-of-rerun)."""
    study = read_study(study_id)
    if study is None:
        raise FileNotFoundError(f"No such study: {study_id}")
    spec = load_spec(Path(study.spec_path))
    cell = next((c for c in study.cells if c.id == cell_id), None)
    if cell is None:
        grid = expand_grid(spec)
        match = next((c for c in grid if c.id == cell_id), None)
        if match is None:
            raise ValueError(f"Unknown cell {cell_id!r} for study {study_id}")
        match.run_id = f"{study_id}_{cell_id}"
        study.cells.append(match)
        cell = match
    cell.status = "pending"
    cell.error = None
    write_study(study)
    sem = asyncio.Semaphore(1)
    await _execute_cell(study, cell, spec, sem)
    return cell.run_id


def validate_spec_for_run(spec_path: Path) -> tuple[StudySpec, PreReg]:
    """Convenience for the API: load spec, ensure prereg validates, return
    both. Raises PreregError or ValueError with a stakeholder-friendly
    message."""
    spec = load_spec(spec_path)
    # Re-validate the prereg as if loaded from disk so error messages match
    # what the multiverse runner will surface at execution time.
    if not spec.prereg.signed_by:
        raise PreregError("prereg.signed_by is required; an unsigned prereg is not a contract.")
    return spec, spec.prereg

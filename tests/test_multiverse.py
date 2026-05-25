"""Smoke tests for the Hypothesis Workbench primitives (multiverse runner,
prereg, manifest, decision-brief contract, spec curve)."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
import yaml

from diageo_research.decision_brief import (
    apply_multiverse_to_brief,
    apply_prereg_to_brief,
)
from diageo_research.manifest import ManifestWriter, hash_json, read_manifest, short_hash
from diageo_research.multiverse import (
    Axis,
    AxisValue,
    Defaults,
    Study,
    StudySpec,
    expand_grid,
    new_study_id,
    read_study,
    render_cell_question,
    write_study,
)
from diageo_research.multiverse_report import (
    _recommendations_from_final,
    build_spec_curve,
    write_spec_curve,
)
from diageo_research.prereg import EvidenceThresholds, PreReg, PreregError, load_prereg, write_prereg


SAMPLES_DIR = Path(__file__).resolve().parents[1] / "samples"


def _fixture_prereg(question: str = "test question") -> PreReg:
    return PreReg(
        question=question,
        decision_rule="reallocate spend if EV gap > 5pp and 60%+ specs agree",
        evidence_thresholds=EvidenceThresholds(
            multiverse_agreement_min=0.6,
            backcasting_pass_min=0,
            effect_size_min=5.0,
        ),
        falsifier_conditions=[
            "Underperforms in three or more defensible specifications.",
            "Lead recommendation robustness is below the 50% majority threshold.",
        ],
        holdout_reservation="Q4 2025 actuals reserved",
        signed_at=datetime(2026, 5, 25, 12, 0, tzinfo=timezone.utc),
        signed_by="Tim Leers",
    )


def _fixture_spec(question: str = "test question") -> StudySpec:
    return StudySpec(
        name="fx",
        question=question,
        prereg=_fixture_prereg(question),
        defaults=Defaults(n_personas=3, max_turns=4),
        concurrency=2,
        axes=[
            Axis(
                name="taxonomy",
                values=[
                    AxisValue(id="demand_space", addendum="Frame via demand-space taxonomy."),
                    AxisValue(id="colab", addendum="Frame via CoLab 13 occasion shifts."),
                ],
            ),
            Axis(
                name="cohort",
                values=[
                    AxisValue(id="sub60k", addendum="Emphasise sub-60k cohorts."),
                    AxisValue(id="mixed", addendum="Cover full income distribution."),
                ],
            ),
        ],
    )


# -------------------------------------------------------------------- prereg


def test_prereg_roundtrip(tmp_path: Path) -> None:
    p = _fixture_prereg()
    target = tmp_path / "prereg.yaml"
    write_prereg(target, p)
    loaded = load_prereg(target)
    assert loaded.signed_by == "Tim Leers"
    assert loaded.evidence_thresholds.multiverse_agreement_min == 0.6
    assert "60%" in "".join(loaded.summary_lines())


def test_prereg_missing_raises(tmp_path: Path) -> None:
    with pytest.raises(PreregError):
        load_prereg(tmp_path / "does-not-exist.yaml")


def test_prereg_invalid_yaml_raises(tmp_path: Path) -> None:
    bad = tmp_path / "bad.yaml"
    bad.write_text("question: x\ndecision_rule: y\n")  # missing required fields
    with pytest.raises(PreregError):
        load_prereg(bad)


# ---------------------------------------------------------- multiverse model


def test_expand_grid_cartesian() -> None:
    spec = _fixture_spec()
    cells = expand_grid(spec)
    assert len(cells) == 4
    ids = sorted(c.id for c in cells)
    assert ids == [
        "colab__mixed",
        "colab__sub60k",
        "demand_space__mixed",
        "demand_space__sub60k",
    ]
    for c in cells:
        assert "n_personas" in c.overrides
        assert c.overrides["n_personas"] == 3
        assert len(c.addenda) == 2


def test_render_cell_question_appends_addenda() -> None:
    rendered = render_cell_question("Q?", ["A1", "A2"])
    assert rendered.startswith("Q?")
    assert "A1" in rendered and "A2" in rendered
    assert "Spec framing" in rendered


def test_render_cell_question_no_addenda_returns_question() -> None:
    assert render_cell_question("Q?", []) == "Q?"


def test_study_persistence_roundtrip(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("RUNS_DIR", str(tmp_path / "runs"))
    from diageo_research.config import get_settings
    get_settings.cache_clear()
    spec = _fixture_spec()
    cells = expand_grid(spec)
    sid = new_study_id()
    for c in cells:
        c.run_id = f"{sid}_{c.id}"
    study = Study(
        id=sid,
        name=spec.name,
        question=spec.question,
        prereg_path=str(tmp_path / "prereg.yaml"),
        spec_path=str(tmp_path / "spec.yaml"),
        cells=cells,
    )
    write_study(study)
    loaded = read_study(sid)
    assert loaded is not None
    assert loaded.id == sid
    assert len(loaded.cells) == 4


# -------------------------------------------------------------- sample yaml


def test_sample_study_yaml_loads_and_validates() -> None:
    """The committed sample must load and validate end-to-end."""
    path = SAMPLES_DIR / "study_pricing_pressure.yaml"
    assert path.exists(), "sample study yaml is missing"
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    spec = StudySpec.model_validate(raw)
    cells = expand_grid(spec)
    assert len(cells) == 8  # 2 x 2 x 2 = 8 cells
    assert spec.prereg.signed_by == "Tim Leers"


# ------------------------------------------------------------------ manifest


def test_manifest_round_trip(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-x"
    mw = ManifestWriter(run_dir, "run-x")
    mw.set_run_inputs(
        question="Q?", settings_summary={"a": 1}, code_anchor_path=__file__
    )
    mw.write_stage(
        "personas",
        elapsed_s=1.2,
        inputs={"n": 3},
        prompt="hello",
        model_id="claude-x",
        outputs=[{"id": "p1"}],
        code_path=__file__,
    )
    mw.finalize()
    m = read_manifest(run_dir)
    assert m is not None
    assert m.run_id == "run-x"
    assert m.question_hash == short_hash("Q?")
    assert m.settings_hash == hash_json({"a": 1})
    assert len(m.stages) == 1
    assert m.stages[0].stage == "personas"
    assert m.stages[0].prompt_hash == short_hash("hello")
    assert m.stages[0].input_hash == hash_json({"n": 3})


# ----------------------------------------------------- decision_brief blocks


def test_apply_prereg_block_idempotent(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-y"
    run_dir.mkdir()
    final_md = run_dir / "final.md"
    final_md.write_text(
        "# Strategy brief — Q?\n\n## Executive answer\n\nSome answer.\n\n"
        "## Findings\n\nDetails.\n",
        encoding="utf-8",
    )
    p = _fixture_prereg()
    assert apply_prereg_to_brief(run_dir, p)
    text1 = final_md.read_text()
    assert "Pre-registration" in text1
    assert "60%" in text1
    # Re-applying should not stack the block.
    assert apply_prereg_to_brief(run_dir, p)
    text2 = final_md.read_text()
    assert text2.count("<!-- prereg-block:start -->") == 1
    assert text2.count("Pre-registration") == 1


def test_apply_prereg_block_when_no_brief(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-z"
    run_dir.mkdir()
    p = _fixture_prereg()
    assert apply_prereg_to_brief(run_dir, p) is False


# ---------------------------------------------------- spec curve heuristics


def test_recommendations_from_final_finds_directives() -> None:
    md = (
        "# Strategy brief — Q?\n\n## Executive answer\n\n"
        "We recommend reallocating spend from Brand A to Brand B because "
        "premium tequila elasticity holds at -0.6 [S1].\n\n"
        "## Findings\n\nThe team should focus on Don Julio 1942 in Texas, "
        "California, and Florida [S2].\n\n"
        "Avoid expanding distribution into low-velocity convenience SKUs.\n"
    )
    recs = _recommendations_from_final(md)
    assert recs, "should find at least one recommendation"
    joined = " ".join(recs).lower()
    assert "reallocat" in joined or "recommend" in joined


def test_spec_curve_clusters_recommendations(tmp_path: Path, monkeypatch) -> None:
    """End-to-end spec curve build with fake briefs across cells."""
    monkeypatch.setenv("RUNS_DIR", str(tmp_path / "runs"))
    from diageo_research.config import get_settings
    get_settings.cache_clear()
    settings = get_settings()
    runs_dir = settings.runs_dir

    spec = _fixture_spec()
    cells = expand_grid(spec)
    sid = new_study_id()
    for c in cells:
        c.run_id = f"{sid}_{c.id}"
    # Simulate three out of four cells agreeing on the lead recommendation;
    # one (colab__mixed) flips it.
    for cell in cells:
        cell_dir = runs_dir / cell.run_id
        cell_dir.mkdir(parents=True, exist_ok=True)
        if cell.id == "colab__mixed":
            md = (
                "# Strategy brief — Q?\n\n## Executive answer\n\n"
                "Do not reallocate campaign spend from Brand A to Brand B; "
                "the cohort signal does not support the move.\n"
            )
        else:
            md = (
                "# Strategy brief — Q?\n\n## Executive answer\n\n"
                "Reallocate campaign spend from Brand A to Brand B; "
                "premium tequila elasticity in this cohort supports the move.\n"
            )
        (cell_dir / "final.md").write_text(md, encoding="utf-8")
        cell.status = "complete"
    # Persist the prereg + study so build_spec_curve can read them.
    study_root = runs_dir / sid
    study_root.mkdir(parents=True, exist_ok=True)
    prereg_path = study_root / "prereg.yaml"
    write_prereg(prereg_path, spec.prereg)
    study = Study(
        id=sid,
        name=spec.name,
        question=spec.question,
        prereg_path=str(prereg_path),
        spec_path=str(study_root / "spec_grid.yaml"),
        cells=cells,
        status="complete",
    )
    write_study(study)

    curve = build_spec_curve(sid)
    assert curve.n_cells == 4
    assert curve.n_complete == 4
    assert curve.rows, "spec curve should emit at least one row"
    lead = curve.rows[0]
    assert lead.n_agree >= 2
    # Falsifier evaluation should produce a verdict, not "unknown" — we
    # provided two heuristically-evaluable conditions in the prereg.
    assert curve.falsifier_status in (
        "not_triggered", "partially_triggered", "fully_triggered"
    )

    # write_spec_curve also augments completed cells' briefs.
    write_spec_curve(sid)
    spec_curve_md = (study_root / "spec_curve.md").read_text(encoding="utf-8")
    assert "Spec curve" in spec_curve_md
    spec_curve_json_text = (study_root / "spec_curve.json").read_text(encoding="utf-8")
    assert "robustness" in spec_curve_json_text

    # The lead cell's brief should now carry both the prereg block and the
    # multiverse summary block (after the call sequence we used here).
    augmented = (runs_dir / cells[0].run_id / "final.md").read_text()
    assert "Multiverse robustness" in augmented


def test_apply_multiverse_block_idempotent(tmp_path: Path, monkeypatch) -> None:
    """Re-applying the multiverse block should replace, not stack."""
    monkeypatch.setenv("RUNS_DIR", str(tmp_path / "runs"))
    from diageo_research.config import get_settings
    get_settings.cache_clear()

    spec = _fixture_spec()
    cells = expand_grid(spec)
    sid = new_study_id()
    runs_dir = get_settings().runs_dir
    for c in cells:
        c.run_id = f"{sid}_{c.id}"
        cell_dir = runs_dir / c.run_id
        cell_dir.mkdir(parents=True, exist_ok=True)
        (cell_dir / "final.md").write_text(
            "# Strategy brief — Q?\n\n## Executive answer\n\n"
            "Reallocate spend from A to B.\n",
            encoding="utf-8",
        )
        c.status = "complete"
    study_root = runs_dir / sid
    study_root.mkdir(parents=True, exist_ok=True)
    prereg_path = study_root / "prereg.yaml"
    write_prereg(prereg_path, spec.prereg)
    write_study(
        Study(
            id=sid,
            name=spec.name,
            question=spec.question,
            prereg_path=str(prereg_path),
            spec_path=str(study_root / "spec_grid.yaml"),
            cells=cells,
            status="complete",
        )
    )

    curve = build_spec_curve(sid)
    cell0 = cells[0]
    cell_dir = runs_dir / cell0.run_id
    apply_multiverse_to_brief(cell_dir, curve, focus_cell_id=cell0.id)
    apply_multiverse_to_brief(cell_dir, curve, focus_cell_id=cell0.id)
    text = (cell_dir / "final.md").read_text()
    assert text.count("<!-- multiverse-block:start -->") == 1
    assert text.count("Multiverse robustness") == 1

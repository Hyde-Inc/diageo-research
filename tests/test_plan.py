"""Contract tests for plan revision and research/trace endpoints."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from diageo_research.multiverse import (
    Axis,
    AxisValue,
    Defaults,
    Study,
    StudySpec,
    expand_grid,
    new_study_id,
    write_study,
)
from diageo_research.prereg import EvidenceThresholds, PreReg, write_prereg
from diageo_research.web.api import app


def _fixture_prereg() -> PreReg:
    return PreReg(
        question="Which occasions are most exposed to price pressure for US tequila?",
        decision_rule="Recommend only if 60%+ scenarios agree.",
        evidence_thresholds=EvidenceThresholds(
            multiverse_agreement_min=0.6,
            backcasting_pass_min=0,
            effect_size_min=5.0,
        ),
        falsifier_conditions=["Lead flips in more than half of scenarios."],
        holdout_reservation="Q4 reserved.",
        signed_at=datetime(2026, 5, 25, 12, 0, tzinfo=timezone.utc),
        signed_by="Tim Leers",
    )


def _fixture_spec() -> StudySpec:
    return StudySpec(
        name="plan-demo",
        question="Which occasions are most exposed to price pressure for US tequila?",
        prereg=_fixture_prereg(),
        defaults=Defaults(n_personas=2, max_turns=2),
        concurrency=1,
        axes=[
            Axis(
                name="taxonomy",
                values=[
                    AxisValue(id="demand_space", addendum="Demand-space framing."),
                    AxisValue(id="colab", addendum="CoLab framing."),
                ],
            ),
        ],
    )


def _seed_study(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setenv("RUNS_DIR", str(tmp_path / "runs"))
    from diageo_research.config import get_settings

    get_settings.cache_clear()
    runs_dir = get_settings().runs_dir

    spec = _fixture_spec()
    cells = expand_grid(spec)
    sid = new_study_id()
    study_root = runs_dir / sid
    study_root.mkdir(parents=True, exist_ok=True)
    prereg_path = study_root / "prereg.yaml"
    write_prereg(prereg_path, spec.prereg)
    spec_path = study_root / "spec_grid.yaml"
    spec_path.write_text(
        yaml.safe_dump(spec.model_dump(mode="json"), sort_keys=False),
        encoding="utf-8",
    )
    for c in cells:
        c.run_id = f"{sid}_{c.id}"
        c.status = "complete"
    write_study(
        Study(
            id=sid,
            name=spec.name,
            question=spec.question,
            prereg_path=str(prereg_path),
            spec_path=str(spec_path),
            cells=cells,
            status="complete",
        )
    )
    return sid


def test_plan_revise_preview_drops_colab(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid = _seed_study(tmp_path, monkeypatch)
    client = TestClient(app)
    res = client.post(
        f"/studies/{sid}/plan/revise",
        json={"instruction": "drop the colab taxonomy", "apply": False},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["applied"] is False
    assert any("CoLab" in line for line in body["diff_lines"])
    after = body["spec_after"]
    tax_vals = next(ax for ax in after["axes"] if ax["name"] == "taxonomy")["values"]
    assert all(v["id"] != "colab" for v in tax_vals)


def test_plan_revise_apply_persists(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid = _seed_study(tmp_path, monkeypatch)
    client = TestClient(app)
    res = client.post(
        f"/studies/{sid}/plan/revise",
        json={
            "instruction": "focus on tequila + Casual Unwind, drop colab",
            "apply": True,
            "rerun": False,
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["applied"] is True
    spec_text = (tmp_path / "runs" / sid / "spec_grid.yaml").read_text(encoding="utf-8")
    assert "id: colab" not in spec_text
    assert "tequila" in spec_text.lower()


def test_research_and_trace_endpoints(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid = _seed_study(tmp_path, monkeypatch)
    client = TestClient(app)
    research = client.get(f"/studies/{sid}/research")
    assert research.status_code == 200, research.text
    data = research.json()
    assert len(data["top_risks"]) == 3
    assert "question" in data

    trace = client.get(
        f"/studies/{sid}/trace",
        params={"trace_id": "72%", "metric": "robustness"},
    )
    assert trace.status_code == 200, trace.text
    t = trace.json()
    assert t["steps"]
    assert "trace_id" in t

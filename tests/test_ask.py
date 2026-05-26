"""Contract tests for the grounded Q&A surface (POST /studies/{id}/ask).

Strategy:
- Stand up a tiny synthetic study under a tmp ``runs/`` dir: prereg.yaml,
  study.json, and one cell's final.md with a recognisable executive answer.
- Patch ``diageo_research.ask._make_client`` to return a fake AsyncAnthropic
  whose ``messages.create`` returns a JSON-shaped reply with citation keys
  the real prompt builder would generate.
- Drive the FastAPI endpoint via TestClient and assert the response shape
  (answer / citations / unknowns), the jargon-avoidance guarantee, and the
  404/400 error contract.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
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


# ------------------------------------------------------------- Fixtures


def _fixture_prereg() -> PreReg:
    return PreReg(
        question="Where is pricing pressure biting hardest?",
        decision_rule=(
            "Reallocate spend from the most-exposed brand-occasion to the "
            "least-exposed one only if EV gap > 5pp and 60%+ scenarios agree."
        ),
        evidence_thresholds=EvidenceThresholds(
            multiverse_agreement_min=0.6,
            backcasting_pass_min=0,
            effect_size_min=5.0,
        ),
        falsifier_conditions=[
            "The recommended target underperforms in three or more scenarios.",
            "Framings disagree on the lead recommendation in more than 50%.",
        ],
        holdout_reservation="Q4 2025 NA volume actuals reserved.",
        signed_at=datetime(2026, 5, 25, 12, 0, tzinfo=timezone.utc),
        signed_by="Tim Leers",
    )


def _fixture_spec() -> StudySpec:
    return StudySpec(
        name="fx-ask",
        question="Where is pricing pressure biting hardest?",
        prereg=_fixture_prereg(),
        defaults=Defaults(n_personas=2, max_turns=3),
        concurrency=2,
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
    """Materialise a tiny study under tmp_path/runs/ and return its id."""
    monkeypatch.setenv("RUNS_DIR", str(tmp_path / "runs"))
    from diageo_research.config import get_settings

    get_settings.cache_clear()
    runs_dir = get_settings().runs_dir

    spec = _fixture_spec()
    cells = expand_grid(spec)
    sid = new_study_id()
    for c in cells:
        c.run_id = f"{sid}_{c.id}"

    # Seed each cell's final.md with a recognisable executive answer so the
    # ask context loader pulls a real excerpt.
    for cell in cells:
        cell_dir = runs_dir / cell.run_id
        cell_dir.mkdir(parents=True, exist_ok=True)
        md = (
            f"# Strategy brief — Q?\n\n"
            f"## Executive answer\n\n"
            f"Smirnoff at the value-vodka tier is the largest near-term "
            f"exposure; tequila in fine dining is the second wound. "
            f"This is cell {cell.id} speaking.\n\n"
            f"## Findings\n\n"
            f"Some details that should not appear verbatim in the answer.\n"
        )
        (cell_dir / "final.md").write_text(md, encoding="utf-8")
        cell.status = "complete"

    # Persist prereg + study.json so build_spec_curve and read_study work.
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
    return sid


class _FakeMessages:
    """Mimics ``client.messages`` with an awaitable ``create``."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> SimpleNamespace:
        self.calls.append(kwargs)
        # Match the Anthropic SDK shape: ``response.content[i].text``.
        block = SimpleNamespace(type="text", text=json.dumps(self._payload))
        return SimpleNamespace(content=[block])


class _FakeAnthropic:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.messages = _FakeMessages(payload)


def _patch_anthropic(
    monkeypatch: pytest.MonkeyPatch,
    payload: dict[str, Any],
) -> _FakeAnthropic:
    fake = _FakeAnthropic(payload)
    monkeypatch.setattr(
        "diageo_research.ask._make_client",
        lambda api_key: fake,
    )
    return fake


# ------------------------------------------------------------- Endpoint


def test_ask_endpoint_returns_structured_answer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid = _seed_study(tmp_path, monkeypatch)
    payload = {
        "answer": (
            "Pricing pressure compresses hardest at the value-vodka tier "
            "for casual unwind [B1]. The fine-dining tequila pocket is the "
            "second exposure [C1]. Treat the answer as moderately robust "
            "across scenarios."
        ),
        "citations": [
            {"key": "B1", "source": "ignored", "snippet": "ignored"},
            {"key": "C1", "source": "ignored", "snippet": "ignored"},
        ],
        "unknowns": ["We don't yet know how a tariff shock would shift this."],
    }
    fake = _patch_anthropic(monkeypatch, payload)

    client = TestClient(app)
    res = client.post(
        f"/studies/{sid}/ask",
        json={"question": "What's the biggest pricing risk right now?"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body.keys()) == {"answer", "citations", "unknowns"}
    assert "value-vodka" in body["answer"]
    assert isinstance(body["citations"], list)
    assert body["citations"], "expected at least one resolved citation"
    # The endpoint must resolve [B1]/[C1] to our curated snippets, not the
    # placeholder text the fake model returned.
    sources = {c["source"] for c in body["citations"]}
    assert any("Scenario" in s for s in sources)
    assert any("Cross-scenario" in s for s in sources)
    # Unknowns surface from both the model and the loader.
    assert any("tariff" in u for u in body["unknowns"])

    # The prompt sent to the model must NOT include forbidden jargon in the
    # *system* slot; system rules forbid that vocabulary in the *answer*.
    # But the user prompt should expose scenarios/dimensions plainly.
    call = fake.messages.calls[0]
    assert "claude" in call["model"]  # uses configured sonnet model id
    user_prompt = call["messages"][0]["content"]
    # Question is included verbatim
    assert "biggest pricing risk" in user_prompt
    # We expose paraphrased decision rule, not raw prereg keys
    assert "decision_rule" not in user_prompt


def test_ask_endpoint_filters_to_scenario(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid = _seed_study(tmp_path, monkeypatch)
    payload = {
        "answer": "Within the demand-space framing the lead remains Smirnoff [B1].",
        "citations": [{"key": "B1", "source": "ignored", "snippet": "ignored"}],
        "unknowns": [],
    }
    fake = _patch_anthropic(monkeypatch, payload)

    client = TestClient(app)
    res = client.post(
        f"/studies/{sid}/ask",
        json={
            "question": "Within this framing, what's the lead exposure?",
            "scenario_id": "demand_space",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert "Smirnoff" in body["answer"]

    user_prompt = fake.messages.calls[0]["messages"][0]["content"]
    assert "demand_space" in user_prompt
    # The focused cell must come first in the rendered scenario briefs so
    # the answerer treats it as the centre of mass.
    pos_focus = user_prompt.find("Scenario demand_space")
    pos_other = user_prompt.find("Scenario colab")
    assert 0 <= pos_focus < pos_other


def test_ask_endpoint_404_on_missing_study(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RUNS_DIR", str(tmp_path / "runs"))
    from diageo_research.config import get_settings

    get_settings.cache_clear()

    client = TestClient(app)
    res = client.post(
        "/studies/study_does_not_exist/ask",
        json={"question": "anything"},
    )
    assert res.status_code == 404


def test_ask_endpoint_400_on_empty_question(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid = _seed_study(tmp_path, monkeypatch)
    client = TestClient(app)
    res = client.post(f"/studies/{sid}/ask", json={"question": ""})
    # Pydantic min_length=1 rejects this with 422; either status is acceptable
    # contract-wise (both signal "bad input"). Assert specifically: not 200.
    assert res.status_code in (400, 422)


def test_ask_endpoint_400_when_scenario_unknown(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid = _seed_study(tmp_path, monkeypatch)
    _patch_anthropic(monkeypatch, {"answer": "x"})
    client = TestClient(app)
    res = client.post(
        f"/studies/{sid}/ask",
        json={"question": "anything", "scenario_id": "no_such_cell"},
    )
    assert res.status_code == 400

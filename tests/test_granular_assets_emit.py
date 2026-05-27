"""Integration tests for the granular asset emit + read path.

These tests exercise the full round-trip:

1. Build a fake :class:`StageContext` (just enough attrs the emit helpers
   read off the object — no orchestrator needed).
2. Emit per-persona + per-turn + per-tool_call + per-citation + per-claim
   materializations against an ephemeral Dagster instance with a tmp
   ``DAGSTER_HOME``.
3. Read the events back through :func:`list_granular_assets` and the
   ``/assets``-family API endpoints to confirm the FE-facing contracts
   (``kind`` filter, ``granular_asset_lineage`` upstream/downstream
   chain, ``/studies/{id}/claims`` payload shape).

The tests deliberately bypass the FastAPI shim for the pure-emit
contract tests (so we can assert metadata exactly), but use the
:class:`TestClient` for the API-level surfaces so the public response
shape is pinned.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from diageo_research import keys
from diageo_research.granular_assets import (
    PERSONA_ASSET_PREFIX,
    citation_asset_key,
    emit_interview_granular,
    emit_synthesis_granular,
    fetch_claims_for_cell,
    granular_asset_lineage,
    list_granular_assets,
    persona_asset_key,
    tool_call_asset_key,
)
from diageo_research.models import (
    Citation,
    DialogueTurn,
    FinalReport,
    Persona,
    SubReport,
)
from diageo_research.multiverse import SpecCell, Study, write_study
from diageo_research.orchestrator import _resolve_dagster_instance
from diageo_research.web.api import app


# ----------------------------------------------------------------- Fixtures


class _FakeContext:
    """Stand-in for :class:`StageContext` used by the emit helpers.

    The emit functions only read ``question``, ``axes``, ``run_id`` off
    a context. We don't need the real one — that would force us to
    spin up the whole orchestrator just to seed an event.
    """

    def __init__(
        self,
        *,
        question: str,
        axes: dict[str, str] | None,
        run_id: str = "test_run_001",
    ) -> None:
        self.question = question
        self.axes = axes
        self.run_id = run_id


@pytest.fixture()
def isolated_dagster_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> Path:
    """Point ``DAGSTER_HOME`` at a tmp dir for the whole test."""
    monkeypatch.setenv("DAGSTER_HOME", str(tmp_path / "dagster_home"))
    return tmp_path


@pytest.fixture()
def runs_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Point :func:`get_settings().runs_dir` at a tmp dir.

    The ``/studies`` endpoints read ``study.json`` from this directory.
    """
    runs_path = tmp_path / "runs"
    runs_path.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("RUNS_DIR", str(runs_path))
    # ``get_settings`` caches; clear it so our env var takes effect.
    from diageo_research.config import get_settings
    get_settings.cache_clear()
    yield runs_path
    get_settings.cache_clear()


def _sample_persona(pid: str = "p1") -> Persona:
    return Persona(
        id=pid,
        name="Anna Analyst",
        role="Spirits Category Analyst",
        lens="Data lens",
        description="...",
        system_prompt="...",
        persona_type="expert",
        checklist=[],
        section_assignments=[],
    )


def _sample_browser_citation(cite_id: str = "B1") -> Citation:
    return Citation(
        cite_id=cite_id,
        source="browser",
        url="https://www.bls.gov/news.release/cpi.htm",
        title="CPI release",
        snippet="off-premise spirits index up 2.3% YoY.",
    )


def _sample_duckdb_citation(cite_id: str = "Q1") -> Citation:
    return Citation(
        cite_id=cite_id,
        source="duckdb",
        sql="SELECT week, sum(units) FROM bls_cpi GROUP BY 1",
        snippet="rows: ...",
    )


# ---------------------------------------------------- emit_interview_granular


def test_emit_interview_granular_emits_persona_turn_and_tool_call_events(
    isolated_dagster_home: Path,
) -> None:
    """Persona + turn + tool_call materializations land in the instance."""
    ctx = _FakeContext(
        question="What is happening with spirits in Q4?",
        axes={"lens": "demand_space"},
    )
    persona = _sample_persona()
    cite = _sample_browser_citation()
    turn = DialogueTurn(
        turn_idx=1,
        question="What's the price story?",
        answer="Prices are up [B1].",
        citations=[cite],
        queries=["spirits CPI 2025"],
        done=True,
    )
    sub_report = SubReport(
        persona_id=persona.id,
        persona_name=persona.name,
        markdown="### {Anna}\n\n- Prices are up [B1].",
        citations=[cite],
        headline_claim="Prices are up YoY.",
    )
    tool_calls = [
        {
            "tool": "web_browse",
            "args": {"query": "spirits CPI"},
            "query": "spirits CPI",
            "outcome": "ok",
            "success": True,
            "started_at": "2026-05-27T00:00:00+00:00",
            "finished_at": "2026-05-27T00:00:05+00:00",
            "latency_s": 5.0,
            "n_snippets": 1,
            "cite_id": "B1",
            "result_summary": "off-premise spirits index up 2.3%",
        }
    ]

    instance = _resolve_dagster_instance()
    try:
        summary = emit_interview_granular(
            instance,
            ctx=ctx,
            persona=persona,
            sub_report=sub_report,
            turns=[turn],
            tool_calls=tool_calls,
            persona_cost_usd=0.12,
            started_at="2026-05-27T00:00:00+00:00",
            finished_at="2026-05-27T00:01:00+00:00",
            turn_timings={1: ("2026-05-27T00:00:00+00:00", "2026-05-27T00:00:05+00:00", 5.0)},
        )
    finally:
        instance.dispose()

    # Summary payload carries everything the workbench needs to render
    # the per-persona detail pane without re-reading the instance.
    assert summary["persona"]["persona_id"] == "p1"
    assert summary["persona"]["n_citations"] == 1
    assert summary["persona"]["cite_ids"] == ["B1"]
    assert summary["persona"]["cost_usd"] == 0.12
    assert len(summary["turns"]) == 1
    assert summary["turns"][0]["turn_idx"] == 1
    assert summary["turns"][0]["latency_s"] == 5.0
    assert len(summary["tool_calls"]) == 1
    tool_payload = summary["tool_calls"][0]
    assert tool_payload["tool"] == "web_browse"
    assert tool_payload["cite_id"] == "B1"
    assert tool_payload["source_label"]
    assert tool_payload["n_snippets"] == 1

    # Read the events back: every emitted asset shows up in the listing.
    instance2 = _resolve_dagster_instance()
    try:
        rows = list_granular_assets(instance2)
        kinds = {r["kind"] for r in rows}
        assert {"persona", "turn", "tool_call"}.issubset(kinds)
    finally:
        instance2.dispose()


# ------------------------------------------------- emit_synthesis_granular


def test_emit_synthesis_granular_links_citations_to_tool_calls(
    isolated_dagster_home: Path,
) -> None:
    """Synthesis citation assets carry tool_call upstream after S? renumber."""
    ctx = _FakeContext(question="Q?", axes={"lens": "demand_space"})
    persona = _sample_persona()
    # Per-persona citation carries B1; after renumber the final brief
    # cites it as S1 against the SAME (source, url) pair.
    persona_cite = _sample_browser_citation(cite_id="B1")
    synth_cite = Citation(
        cite_id="S1",
        source="browser",
        url=persona_cite.url,
        title=persona_cite.title,
        snippet=persona_cite.snippet,
    )
    sub_report = SubReport(
        persona_id=persona.id,
        persona_name=persona.name,
        markdown="...",
        citations=[persona_cite],
        headline_claim="Prices up.",
    )
    tool_calls = {
        persona.id: [
            {
                "tool": "web_browse",
                "args": {"query": "spirits CPI"},
                "url": persona_cite.url,
                "outcome": "ok",
                "success": True,
                "cite_id": "B1",
                "started_at": "2026-05-27T00:00:00+00:00",
                "finished_at": "2026-05-27T00:00:05+00:00",
                "latency_s": 5.0,
                "n_snippets": 1,
            }
        ]
    }
    final = FinalReport(
        question=ctx.question,
        outline=["Exec summary"],
        markdown="# Brief\n\n## Exec summary\n\nSpirits prices are up [S1].",
        citations=[synth_cite],
    )

    instance = _resolve_dagster_instance()
    try:
        result = emit_synthesis_granular(
            instance,
            ctx=ctx,
            final_report=final,
            sub_reports=[sub_report],
            tool_call_logs=tool_calls,
        )
    finally:
        instance.dispose()

    # One citation, one claim, with the cite linked back to its tool_call
    # through the (source, url) join even though the cite_id changed.
    assert result["n_citations"] == 1
    assert result["n_claims"] == 1
    citation_payload = result["citations"][0]
    assert citation_payload["cite_id"] == "S1"
    assert citation_payload["source_label"] == (
        "BLS (US Bureau of Labor Statistics)"
    )
    assert persona.id in citation_payload["personas_cited"]
    # The upstream list points at the tool_call asset key path.
    expected_tool_key = tool_call_asset_key(
        question=ctx.question, axes=ctx.axes, persona_id=persona.id, seq=1
    )
    assert expected_tool_key in citation_payload["upstream"]

    claim_payload = result["claims"][0]
    assert claim_payload["cite_ids"] == ["S1"]
    assert claim_payload["text"].startswith("Spirits prices are up")
    # Claim asset upstream points at the citation asset key.
    expected_cit_key = citation_asset_key(
        question=ctx.question, axes=ctx.axes, cite_id="S1"
    )
    assert expected_cit_key in claim_payload["upstream"]


# ----------------------------------------------- granular_asset_lineage


def test_granular_asset_lineage_uses_metadata_when_present() -> None:
    """When the latest record carries upstream/downstream, use them."""
    record = {
        "metadata": {
            "upstream": [["persona_interview", "qh", "sig", "p1"], ["interviews"]],
            "downstream": [["citation", "qh", "sig", "S1"]],
        }
    }
    out = granular_asset_lineage(
        ["tool_call", "qh", "sig", "p1", "c1"], latest_record=record
    )
    assert out is not None
    assert ["interviews"] in out["upstream"]
    assert ["citation", "qh", "sig", "S1"] in out["downstream"]


def test_granular_asset_lineage_falls_back_synthetically_when_no_metadata() -> None:
    """Brand-new keys with no events fall back to a synthetic chain."""
    out = granular_asset_lineage(["persona_interview", "qh", "sig", "p1"])
    assert out is not None
    assert ["interviews"] in out["upstream"]
    assert ["synthesis"] in out["downstream"]


def test_granular_asset_lineage_returns_none_for_non_granular_key() -> None:
    """Stage / cell asset keys return None so the caller falls back to declared."""
    assert granular_asset_lineage(["synthesis"]) is None
    assert granular_asset_lineage(["research_cell", "qh", "sig"]) is None


# -------------------------------------------------- /assets kind filter


def test_get_assets_kind_filter_isolates_granular_kinds(
    isolated_dagster_home: Path,
) -> None:
    """``GET /assets?kind=persona`` returns only persona materializations."""
    ctx = _FakeContext(question="Q?", axes={"lens": "x"})
    persona = _sample_persona()
    cite = _sample_browser_citation()
    instance = _resolve_dagster_instance()
    try:
        emit_interview_granular(
            instance,
            ctx=ctx,
            persona=persona,
            sub_report=SubReport(
                persona_id=persona.id,
                persona_name=persona.name,
                markdown="...",
                citations=[cite],
                headline_claim="ok",
            ),
            turns=[
                DialogueTurn(
                    turn_idx=1, question="q?", answer="a [B1].", citations=[cite]
                )
            ],
            tool_calls=[
                {
                    "tool": "web_fetch",
                    "args": {"url": cite.url},
                    "url": cite.url,
                    "outcome": "ok",
                    "success": True,
                    "cite_id": "B1",
                    "latency_s": 1.0,
                    "n_snippets": 1,
                }
            ],
        )
    finally:
        instance.dispose()

    client = TestClient(app)
    r = client.get("/assets", params={"kind": "persona"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind_filter"] == "persona"
    assert body["kinds"]
    # Every returned row is a persona row.
    for row in body["assets"]:
        assert row["kind"] == "persona"
        assert row["asset_key"][0] == PERSONA_ASSET_PREFIX
    # Now request tool_call kind specifically — confirm we don't get the
    # persona rows in the mix.
    r2 = client.get("/assets", params={"kind": "tool_call"})
    assert r2.status_code == 200
    for row in r2.json()["assets"]:
        assert row["kind"] == "tool_call"


def test_get_assets_rejects_unknown_kind() -> None:
    client = TestClient(app)
    r = client.get("/assets", params={"kind": "made-up"})
    assert r.status_code == 400
    assert "unknown kind" in r.json()["detail"]


# --------------------------------------------- /assets/{key}/lineage granular


def test_get_asset_lineage_granular_key_uses_metadata(
    isolated_dagster_home: Path,
) -> None:
    """``/lineage`` for a granular key surfaces the recorded chain."""
    ctx = _FakeContext(question="Q?", axes={"lens": "x"})
    persona = _sample_persona()
    cite = _sample_browser_citation()
    instance = _resolve_dagster_instance()
    try:
        emit_interview_granular(
            instance,
            ctx=ctx,
            persona=persona,
            sub_report=SubReport(
                persona_id=persona.id,
                persona_name=persona.name,
                markdown="...",
                citations=[cite],
                headline_claim="ok",
            ),
            turns=[
                DialogueTurn(
                    turn_idx=1, question="q?", answer="a [B1].", citations=[cite]
                )
            ],
            tool_calls=[
                {
                    "tool": "web_fetch",
                    "args": {"url": cite.url},
                    "url": cite.url,
                    "outcome": "ok",
                    "success": True,
                    "cite_id": "B1",
                    "latency_s": 1.0,
                    "n_snippets": 1,
                }
            ],
        )
    finally:
        instance.dispose()

    persona_key = persona_asset_key(
        question=ctx.question, axes=ctx.axes, persona_id=persona.id
    )
    encoded = keys.encode_asset_key(persona_key)
    client = TestClient(app)
    r = client.get(f"/assets/{encoded}/lineage")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "persona"
    upstream_paths = [entry["asset_key"] for entry in body["upstream"]]
    assert ["interviews"] in upstream_paths


# --------------------------------------------- /studies/{id}/claims endpoint


def test_get_study_claims_returns_parsed_claims_per_cell(
    isolated_dagster_home: Path, runs_dir: Path
) -> None:
    """The endpoint reads claim assets back from the persistent instance."""
    ctx = _FakeContext(question="Q?", axes={"lens": "demand_space"})
    persona = _sample_persona()
    cite = _sample_browser_citation()
    final = FinalReport(
        question=ctx.question,
        outline=["Exec"],
        markdown="## Exec\n\nSpirits up [S1].",
        citations=[
            Citation(
                cite_id="S1",
                source="browser",
                url=cite.url,
                title=cite.title,
                snippet=cite.snippet,
            )
        ],
    )

    instance = _resolve_dagster_instance()
    try:
        emit_synthesis_granular(
            instance,
            ctx=ctx,
            final_report=final,
            sub_reports=[
                SubReport(
                    persona_id=persona.id,
                    persona_name=persona.name,
                    markdown="...",
                    citations=[cite],
                    headline_claim="ok",
                )
            ],
            tool_call_logs={
                persona.id: [
                    {
                        "tool": "web_fetch",
                        "args": {"url": cite.url},
                        "url": cite.url,
                        "outcome": "ok",
                        "success": True,
                        "cite_id": "B1",
                        "latency_s": 1.0,
                        "n_snippets": 1,
                    }
                ]
            },
        )
    finally:
        instance.dispose()

    # Persist a Study record so /studies/{id}/claims can find the cell.
    study = Study(
        id="study_test_001",
        name="smoke",
        question=ctx.question,
        cell_question_template=ctx.question,
        prereg_path=str(runs_dir / "prereg.json"),
        spec_path=str(runs_dir / "spec.yaml"),
        cells=[
            SpecCell(
                id="lens__demand_space",
                axes=ctx.axes or {},
                addenda=[],
                run_id="r1",
                status="complete",
            )
        ],
        status="complete",
    )
    write_study(study)

    client = TestClient(app)
    r = client.get(f"/studies/{study.id}/claims")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["study_id"] == study.id
    assert body["n_claims"] == 1
    assert body["cells"]
    cell = body["cells"][0]
    assert cell["cell_id"] == "lens__demand_space"
    assert cell["axes"] == {"lens": "demand_space"}
    assert cell["question_hash"]
    assert cell["axes_signature"]
    assert cell["claims"]
    claim = cell["claims"][0]
    assert claim["text"].startswith("Spirits up")
    assert claim["cite_ids"] == ["S1"]
    # Denormalised citation summary so the FE never re-parses final.md.
    assert claim["citations"]
    cit_summary = claim["citations"][0]
    assert cit_summary["cite_id"] == "S1"
    assert cit_summary["source_label"] == "BLS (US Bureau of Labor Statistics)"


def test_get_study_claims_404_for_missing_study(runs_dir: Path) -> None:
    client = TestClient(app)
    r = client.get("/studies/study_does_not_exist/claims")
    assert r.status_code == 404


def test_get_study_claims_marks_pending_cells_unavailable(
    isolated_dagster_home: Path, runs_dir: Path
) -> None:
    """Cells with no claim assets get an honest unavailable_reason, not a placeholder."""
    study = Study(
        id="study_test_002",
        name="smoke",
        question="An un-run question",
        cell_question_template="An un-run question",
        prereg_path="",
        spec_path="",
        cells=[
            SpecCell(id="solo", axes={}, addenda=[], run_id="r-pending", status="pending")
        ],
        status="pending",
    )
    write_study(study)
    client = TestClient(app)
    r = client.get(f"/studies/{study.id}/claims")
    assert r.status_code == 200
    body = r.json()
    assert body["n_claims"] == 0
    assert body["cells"][0]["claims"] == []
    assert "unavailable_reason" in body["cells"][0]


# -------------------------------------------- fetch_claims_for_cell helper


def test_fetch_claims_for_cell_filters_by_signature(
    isolated_dagster_home: Path,
) -> None:
    """The helper narrows the listing to one (question_hash, axes_signature)."""
    cite = _sample_browser_citation()
    instance = _resolve_dagster_instance()
    try:
        emit_synthesis_granular(
            instance,
            ctx=_FakeContext(question="Q1?", axes={"lens": "a"}),
            final_report=FinalReport(
                question="Q1?",
                outline=["x"],
                markdown="## x\n\nclaim a [S1].",
                citations=[
                    Citation(
                        cite_id="S1",
                        source="browser",
                        url=cite.url,
                        snippet="x",
                    )
                ],
            ),
            sub_reports=[],
            tool_call_logs=None,
        )
        emit_synthesis_granular(
            instance,
            ctx=_FakeContext(question="Q2?", axes={"lens": "b"}),
            final_report=FinalReport(
                question="Q2?",
                outline=["y"],
                markdown="## y\n\nclaim b [S1].",
                citations=[
                    Citation(
                        cite_id="S1",
                        source="browser",
                        url=cite.url,
                        snippet="x",
                    )
                ],
            ),
            sub_reports=[],
            tool_call_logs=None,
        )
    finally:
        instance.dispose()

    qh_q1 = keys.hash_question("Q1?")
    sig_q1 = keys.axes_signature({"lens": "a"})
    instance2 = _resolve_dagster_instance()
    try:
        rows = fetch_claims_for_cell(
            instance2, question_hash=qh_q1, axes_signature=sig_q1
        )
    finally:
        instance2.dispose()
    assert len(rows) == 1
    md = rows[0].get("metadata") or {}
    assert md.get("text", "").startswith("claim a")

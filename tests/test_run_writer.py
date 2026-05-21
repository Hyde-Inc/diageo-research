"""Smoke tests for the per-stage markdown writer + prefix resolver."""
from pathlib import Path

from diageo_research.models import (
    Citation,
    DialogueTurn,
    OutlineSection,
    Persona,
    SubReport,
)
from diageo_research.run_writer import (
    RunWriter,
    list_runs,
    list_stage_files,
    resolve_run_prefix,
)


def _persona(i: int, persona_type: str = "expert") -> Persona:
    return Persona(
        id=f"p{i}",
        name=f"Persona {i}",
        role="role",
        lens="lens",
        description="background",
        system_prompt="speak in character",
        persona_type=persona_type,  # type: ignore[arg-type]
        checklist=["q1?", "q2?"],
    )


def test_run_writer_emits_all_stage_files(tmp_path: Path):
    writer = RunWriter(tmp_path)
    personas = [_persona(1, "consumer"), _persona(2, "expert")]

    writer.write_question("Test Q", 2, 3, {"a": 1, "b": True})
    writer.write_personas(personas)
    writer.write_seed_outline(
        "exec intent",
        [OutlineSection(heading="A", intent="i-a"), OutlineSection(heading="B")],
        {"p1": ["A"], "p2": ["B"]},
        personas,
    )
    turn = DialogueTurn(
        turn_idx=1,
        question="Q1?",
        answer="A1",
        citations=[Citation(cite_id="Q1", source="duckdb", sql="SELECT 1")],
        queries=["SELECT 1"],
    )
    writer.write_interview(personas[0], [turn])

    sub = SubReport(
        persona_id="p1",
        persona_name="Persona 1",
        markdown="claim text [Q1]",
        citations=[Citation(cite_id="Q1", source="duckdb", sql="SELECT 1", verified=True,
                            verification_note="matched 1 of 1")],
        headline_claim="A short headline",
    )
    writer.write_subreports([sub])
    writer.write_verifier([sub])
    writer.write_final_outline("exec answer", ["A", "B"])
    writer.write_run_summary(
        question="Test Q",
        elapsed_s=12.5,
        n_personas=2,
        n_subreports=1,
        n_citations=1,
        verified=1,
        flagged=0,
        stage_timings=[("personas", 2.0), ("interviews", 8.0)],
    )
    writer.write_index()

    stages = list_stage_files(tmp_path)
    slugs = [s for s, _ in stages]
    # All key stages present and in lexical order (= chronological)
    expected = [
        "00_question",
        "01_personas",
        "02_seed_outline",
        "03_interview_p1",
        "04_subreports",
        "06_verifier",
        "07_final_outline",
        "99_index",
        "99_run_summary",
    ]
    for e in expected:
        assert e in slugs, f"missing stage {e}"
    # Challenge file must NOT be created anymore
    assert "05_challenge_reactions" not in slugs
    for _, path in stages:
        assert path.stat().st_size > 0


def test_run_writer_writes_consumer_badge(tmp_path: Path):
    writer = RunWriter(tmp_path)
    writer.write_personas([_persona(1, "consumer"), _persona(2, "expert")])
    text = (tmp_path / "stages" / "01_personas.md").read_text()
    assert "consumer" in text
    assert "expert" in text


def test_run_writer_verifier_table_shows_badges(tmp_path: Path):
    writer = RunWriter(tmp_path)
    sub = SubReport(
        persona_id="p1",
        persona_name="x",
        markdown="claim [Q1] [Q2]",
        citations=[
            Citation(cite_id="Q1", source="duckdb", sql="SELECT 1", verified=True),
            Citation(cite_id="Q2", source="duckdb", sql="SELECT 2", verified=False),
        ],
    )
    writer.write_verifier([sub])
    text = (tmp_path / "stages" / "06_verifier.md").read_text()
    assert "✓" in text
    assert "⚠" in text
    assert "`Q1`" in text and "`Q2`" in text


def test_resolve_run_prefix_unique(tmp_path: Path):
    (tmp_path / "abc12345").mkdir()
    (tmp_path / "def67890").mkdir()
    assert resolve_run_prefix(tmp_path, "abc").name == "abc12345"
    assert resolve_run_prefix(tmp_path, "def").name == "def67890"


def test_resolve_run_prefix_ambiguous_returns_none(tmp_path: Path):
    (tmp_path / "abc111").mkdir()
    (tmp_path / "abc222").mkdir()
    assert resolve_run_prefix(tmp_path, "abc") is None


def test_resolve_run_prefix_missing_returns_none(tmp_path: Path):
    (tmp_path / "abc").mkdir()
    assert resolve_run_prefix(tmp_path, "zzz") is None


def test_list_runs_picks_up_question_from_events(tmp_path: Path):
    rdir = tmp_path / "abc123"
    rdir.mkdir()
    (rdir / "events.jsonl").write_text(
        '{"type":"run_started","run_id":"abc123","data":{"question":"What now?","personas":2,"max_turns":3},"ts":"2026-05-21T10:00:00Z"}\n'
    )
    rows = list_runs(tmp_path)
    assert any(r["id"] == "abc123" and "What now?" in r["question"] for r in rows)

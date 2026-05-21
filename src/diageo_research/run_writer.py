"""Per-stage markdown artifacts under `runs/<id>/stages/`.

Lets you analyse a run in the terminal without parsing `events.jsonl`. One
markdown file per pipeline stage so you can `cat`, `bat`, `glow`, or
`diageo report <id> --stage personas` to inspect any phase.

Layout:

    runs/<id>/
      events.jsonl                  ← raw event stream (existing)
      final.md, final.json          ← final brief (existing)
      p1/transcript.json            ← per-persona JSON (existing)
      stages/
        00_question.md              ← input + settings + timing
        01_personas.md              ← hybrid panel + checklists + system prompts
        02_seed_outline.md          ← outline-first sections + assignments
        03_interview_<pid>.md       ← one per persona, Q/A + tool calls
        04_subreports.md            ← every persona's headline + sub-report
        05_challenge_reactions.md   ← cross-persona reactions matrix
        06_verifier.md              ← table of [Q?] citations + verified/flagged
        07_final_outline.md         ← final section list as synthesised
        99_index.md                 ← table of contents for the run
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

from .models import (
    DialogueTurn,
    OutlineSection,
    Persona,
    QuestionPlan,
    SubReport,
)

logger = logging.getLogger(__name__)


class RunWriter:
    """Writes per-stage markdown artifacts for one run."""

    def __init__(self, run_dir: Path) -> None:
        self.run_dir = run_dir
        self.stages_dir = run_dir / "stages"
        self.stages_dir.mkdir(parents=True, exist_ok=True)
        self._index: list[tuple[str, str]] = []  # (filename, label)

    # ------------------------------------------------------------------ stages

    def write_question(
        self,
        question: str,
        n_personas: int,
        max_turns: int,
        settings_summary: dict[str, object],
    ) -> Path:
        body = [
            "# 00 — Question & settings",
            "",
            f"**Question:** {question}",
            "",
            f"**Personas:** {n_personas}   **Max turns/persona:** {max_turns}",
            "",
            f"**Started:** {_now()}",
            "",
            "## Settings",
            "",
        ]
        for k, v in settings_summary.items():
            body.append(f"- `{k}` = `{v}`")
        return self._write("00_question.md", "Question", "\n".join(body))

    def write_question_plan(
        self, plan: QuestionPlan, user_override: int | None = None
    ) -> Path:
        body = ["# 00b — Question analysis (right-sizing the panel)", ""]
        body.append(
            f"**Complexity:** {plan.complexity} (score **{plan.complexity_score} / 5**)"
        )
        body.append("")
        body.append(
            f"**Recommended persona count:** **{plan.recommended_personas}**"
            + (
                f"  ·  user override: `--personas {user_override}`"
                if user_override is not None and user_override != plan.recommended_personas
                else ""
            )
        )
        body.append("")
        if plan.axes:
            body.append("**Strategic axes this question touches:**")
            body.append("")
            for a in plan.axes:
                body.append(f"- {a}")
            body.append("")
        if plan.must_have_perspectives:
            body.append("## Seed perspectives (one per persona slot)")
            body.append("")
            body.append("| # | Type | Anchor | Why this question needs them |")
            body.append("|---|---|---|---|")
            for i, sp in enumerate(plan.must_have_perspectives, 1):
                anchor = sp.anchor.replace("|", "\\|")
                why = sp.why.replace("|", "\\|")
                body.append(
                    f"| {i} | {sp.persona_type} | {anchor} | {why} |"
                )
            body.append("")
        if plan.sub_questions:
            body.append("## Sub-questions decomposed from the brief")
            body.append("")
            for i, q in enumerate(plan.sub_questions, 1):
                body.append(f"{i}. {q}")
            body.append("")
        if plan.rationale:
            body.append("## Analyst rationale")
            body.append("")
            body.append(plan.rationale)
            body.append("")
        return self._write("00b_question_plan.md", "Question plan", "\n".join(body))

    def write_personas(self, personas: list[Persona]) -> Path:
        body = ["# 01 — Personas (hybrid consumer + expert panel)", ""]
        n_consumer = sum(1 for p in personas if p.persona_type == "consumer")
        n_expert = sum(1 for p in personas if p.persona_type == "expert")
        body.append(
            f"**Panel:** {len(personas)} total — {n_consumer} consumer · {n_expert} expert"
        )
        body.append("")
        for p in personas:
            badge = "🛒 consumer" if p.persona_type == "consumer" else "📊 expert"
            body.append(f"## {p.id} · {badge} · {p.name}")
            body.append("")
            body.append(f"**Role:** {p.role}")
            body.append("")
            body.append(f"**Lens:** {p.lens}")
            body.append("")
            body.append("**Background:**")
            body.append("")
            body.append(p.description)
            body.append("")
            if p.checklist:
                body.append("**Research checklist:**")
                body.append("")
                for item in p.checklist:
                    body.append(f"- [ ] {item}")
                body.append("")
            body.append("**System prompt:**")
            body.append("")
            body.append("> " + p.system_prompt.replace("\n", "\n> "))
            body.append("")
        return self._write("01_personas.md", "Personas", "\n".join(body))

    def write_seed_outline(
        self,
        executive_intent: str,
        sections: list[OutlineSection],
        assignments: dict[str, list[str]],
        personas: list[Persona],
    ) -> Path:
        body = [
            "# 02 — Seed outline & section assignments",
            "",
            "**Executive intent (drafted BEFORE interviews):**",
            "",
            f"> {executive_intent}",
            "",
            "## Sections",
            "",
        ]
        for i, s in enumerate(sections, 1):
            body.append(f"### {i}. {s.heading}")
            if s.intent:
                body.append("")
                body.append(s.intent)
            body.append("")
        body.append("## Section assignments")
        body.append("")
        body.append("| Persona | Type | Sections owned |")
        body.append("|---|---|---|")
        for p in personas:
            hs = assignments.get(p.id, [])
            body.append(
                f"| **{p.id}** {p.name} | {p.persona_type} | "
                f"{'; '.join(hs) if hs else '(none)'} |"
            )
        body.append("")
        return self._write("02_seed_outline.md", "Seed outline", "\n".join(body))

    def write_interview(
        self, persona: Persona, turns: list[DialogueTurn]
    ) -> Path:
        body = [
            f"# 03 — Interview · {persona.id} · {persona.name}",
            "",
            f"**Type:** {persona.persona_type}   **Role:** {persona.role}",
            "",
            f"**Turns completed:** {len(turns)}",
            "",
        ]
        if persona.section_assignments:
            body.append(
                "**Sections this persona is driving:** "
                + ", ".join(persona.section_assignments)
            )
            body.append("")
        if persona.checklist:
            body.append("**Checklist:**")
            body.append("")
            for c in persona.checklist:
                body.append(f"- {c}")
            body.append("")
        for t in turns:
            body.append("---")
            body.append("")
            body.append(f"### Turn {t.turn_idx}")
            body.append("")
            body.append(f"**Q:** {t.question}")
            body.append("")
            if t.queries:
                body.append("**Tool calls — SQL:**")
                body.append("")
                for q in t.queries:
                    body.append("```sql")
                    body.append(q.strip())
                    body.append("```")
                body.append("")
            body.append("**A:**")
            body.append("")
            body.append(t.answer)
            body.append("")
            if t.citations:
                body.append(
                    f"_Citations on this turn ({len(t.citations)}): "
                    + ", ".join(f"`[{c.cite_id}]`" for c in t.citations)
                    + "_"
                )
                body.append("")
            if t.done:
                body.append("_Turn ended with `<<DONE>>` sentinel._")
                body.append("")
        fname = f"03_interview_{persona.id}.md"
        return self._write(fname, f"Interview {persona.id}", "\n".join(body))

    def write_subreports(self, sub_reports: list[SubReport]) -> Path:
        body = [
            "# 04 — Sub-reports",
            "",
            f"_{len(sub_reports)} personas produced sub-reports._",
            "",
        ]
        for s in sub_reports:
            body.append(f"## {s.persona_id} · {s.persona_name}")
            body.append("")
            if s.headline_claim:
                body.append(f"**Headline claim:** {s.headline_claim}")
                body.append("")
            body.append(s.markdown)
            body.append("")
            if s.citations:
                body.append(
                    f"_Citations in this sub-report ({len(s.citations)}): "
                    + ", ".join(f"`[{c.cite_id}]`" for c in s.citations)
                    + "_"
                )
                body.append("")
            body.append("---")
            body.append("")
        return self._write("04_subreports.md", "Sub-reports", "\n".join(body))

    def write_verifier(self, sub_reports: list[SubReport]) -> Path:
        all_q = [
            (s.persona_id, c)
            for s in sub_reports
            for c in s.citations
            if c.source == "duckdb"
        ]
        verified = sum(1 for _pid, c in all_q if c.verified is True)
        flagged = sum(1 for _pid, c in all_q if c.verified is False)
        body = [
            "# 06 — Verifier results (DuckDB re-execution)",
            "",
            f"**DuckDB citations:** {len(all_q)}   "
            f"**Verified ✓:** {verified}   "
            f"**Flagged ⚠:** {flagged}   "
            f"**Skipped/unknown:** {len(all_q) - verified - flagged}",
            "",
        ]
        if not all_q:
            body.append("_No DuckDB citations in this run._")
            return self._write("06_verifier.md", "Verifier", "\n".join(body))
        body.append("| Persona | Cite | Status | Note | SQL |")
        body.append("|---|---|---|---|---|")
        for pid, c in all_q:
            status = (
                "✓" if c.verified is True else ("⚠" if c.verified is False else "·")
            )
            sql = (c.sql or "").strip().replace("\n", " ")
            if len(sql) > 80:
                sql = sql[:77] + "..."
            note = (c.verification_note or "").replace("|", "\\|")
            body.append(
                f"| {pid} | `{c.cite_id}` | {status} | {note} | `{sql}` |"
            )
        body.append("")
        return self._write("06_verifier.md", "Verifier", "\n".join(body))

    def write_final_outline(
        self, executive_answer: str, sections: list[str]
    ) -> Path:
        body = ["# 07 — Final outline (as synthesised)", ""]
        body.append("**Executive answer:**")
        body.append("")
        body.append(f"> {executive_answer or '(generated post-hoc)'}")
        body.append("")
        body.append("**Sections:**")
        body.append("")
        for i, h in enumerate(sections, 1):
            body.append(f"{i}. {h}")
        body.append("")
        return self._write("07_final_outline.md", "Final outline", "\n".join(body))

    def write_run_summary(
        self,
        question: str,
        elapsed_s: float,
        n_personas: int,
        n_subreports: int,
        n_citations: int,
        verified: int,
        flagged: int,
        n_reactions: int = 0,  # kept for back-compat; challenge round removed
        stage_timings: list[tuple[str, float]] | None = None,
    ) -> Path:
        stage_timings = stage_timings or []
        body = [
            "# 99 — Run summary",
            "",
            f"**Question:** {question}",
            "",
            f"**Finished:** {_now()}   **Total wall time:** {_fmt_elapsed(elapsed_s)}",
            "",
            "## Counters",
            "",
            f"- Personas: **{n_personas}**",
            f"- Sub-reports produced: **{n_subreports}**",
            f"- Citations in final brief: **{n_citations}**",
            f"- DuckDB citations verified ✓: **{verified}**",
            f"- DuckDB citations flagged ⚠: **{flagged}**",
            "",
            "## Stage timings",
            "",
            "| Stage | Duration (s) |",
            "|---|---:|",
        ]
        for stage, secs in stage_timings:
            body.append(f"| {stage} | {secs:.1f} |")
        body.append(
            f"| **total** | **{elapsed_s:.1f}** |"
        )
        return self._write("99_run_summary.md", "Run summary", "\n".join(body))

    def write_index(self) -> Path:
        body = ["# Stage index", ""]
        body.append(f"_{len(self._index)} stage files, written to_ `{self.stages_dir}`")
        body.append("")
        for fname, label in self._index:
            body.append(f"- [`{fname}`](./{fname}) — {label}")
        return self._write_no_index("99_index.md", "\n".join(body))

    # ----------------------------------------------------------------- helpers

    def _write(self, filename: str, label: str, contents: str) -> Path:
        path = self.stages_dir / filename
        path.write_text(contents, encoding="utf-8")
        # Avoid duplicates if a stage is rewritten on retry
        self._index = [(f, l) for f, l in self._index if f != filename]
        self._index.append((filename, label))
        logger.info("wrote stage file %s (%d bytes)", filename, len(contents))
        return path

    def _write_no_index(self, filename: str, contents: str) -> Path:
        path = self.stages_dir / filename
        path.write_text(contents, encoding="utf-8")
        return path


def list_stage_files(run_dir: Path) -> list[tuple[str, Path]]:
    """Return [(slug, path)] for every stage file in lexical (= chronological) order."""
    stages = run_dir / "stages"
    if not stages.exists():
        return []
    return [
        (p.stem, p)
        for p in sorted(stages.glob("*.md"))
    ]


def resolve_run_prefix(runs_dir: Path, prefix: str) -> Path | None:
    """Resolve a (possibly prefix) run id to its directory. Returns None if no
    match or multiple matches (caller decides how to render the ambiguity)."""
    if not runs_dir.exists():
        return None
    if not prefix:
        return None
    candidates = sorted(
        p for p in runs_dir.iterdir() if p.is_dir() and p.name.startswith(prefix)
    )
    if len(candidates) == 1:
        return candidates[0]
    return None


def list_runs(runs_dir: Path) -> list[dict[str, str]]:
    """Return run summaries sorted newest-first. Each dict has: id, question,
    started, status."""
    if not runs_dir.exists():
        return []
    out: list[dict[str, str]] = []
    for p in sorted(runs_dir.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        if not p.is_dir():
            continue
        info = {
            "id": p.name,
            "question": "(unknown)",
            "started": datetime.fromtimestamp(p.stat().st_ctime).strftime(
                "%Y-%m-%d %H:%M"
            ),
            "status": "incomplete",
        }
        events_path = p / "events.jsonl"
        if events_path.exists():
            try:
                with events_path.open() as f:
                    first = f.readline()
                if first:
                    obj = json.loads(first)
                    info["question"] = str(obj.get("data", {}).get("question", info["question"]))
            except Exception:  # noqa: BLE001
                pass
        if (p / "final.md").exists():
            info["status"] = "complete"
        elif events_path.exists() and events_path.stat().st_size > 0:
            with events_path.open() as f:
                for last in f:
                    pass
                try:
                    obj = json.loads(last)
                    if obj.get("type") == "error":
                        info["status"] = "error"
                except Exception:  # noqa: BLE001
                    pass
        out.append(info)
    return out


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _fmt_elapsed(seconds: float) -> str:
    s = int(seconds)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}h{m:02d}m{s:02d}s"
    if m:
        return f"{m}m{s:02d}s"
    return f"{s}s"


def _clip(text: str, n: int) -> str:
    text = (text or "").replace("\n", " ").strip()
    return text if len(text) <= n else text[: max(0, n - 1)] + "…"

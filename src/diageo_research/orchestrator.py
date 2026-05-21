"""Top-level pipeline: question → analyst panel → outline → parallel
interviews → verifier → final report.

Pipeline order:
  0. analyze_question (Opus) → QuestionPlan (panel size + lens seeds)
  1. generate_personas (Opus) → analyst-only panel with checklists
  2. draft_seed_outline (Opus) → outline-first spine
  3. assign_sections (Sonnet) → each persona owns 1–2 sections
  4. parallel interviews (Sonnet + parallel tool dispatch) → DialogueTurns
  5. draft_subreport (Sonnet) → SubReport per persona with headline_claim
  6. verify_subreports (DuckDB re-exec in parallel) → Citation.verified
  7. synthesize (Opus, parallel section writers + charts/tables + evidence
     appendix) → FinalReport

Contradictions between sub-reports are handled by the synthesizer itself —
the previous cross-persona challenge round was removed because the section
writer already has the full sub-report bundle and surfaces disagreements
better than a separate "reactions" stage (which doubled wall time without
adding insight).
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

from anthropic import AsyncAnthropic

from .config import get_settings
from .events import EventBus, create_bus
from .interviewer import Interviewer
from .memory import DialogueMemory
from .models import DialogueTurn, FinalReport, OutlineSection, Persona, SSEEvent, SubReport
from .outline import assign_sections, draft_seed_outline
from .persona_generator import generate_personas
from .perspective import PerspectiveAgent
from .question_analysis import analyze_question
from .run_writer import RunWriter
from .summarizer import draft_subreport, synthesize
from .tools.duckdb_tool import schema_summary
from .verifier import verify_subreports

logger = logging.getLogger(__name__)


def new_run_id() -> str:
    return uuid.uuid4().hex[:12]


async def run_research(
    question: str,
    run_id: str | None = None,
    n_personas: int | None = None,
    max_turns: int | None = None,
) -> FinalReport:
    """Run the multi-perspective research pipeline. If `n_personas` is None
    (the common CLI default), the upfront question analyzer sizes the panel
    to the question; the user override always wins when supplied."""
    settings = get_settings()
    run_id = run_id or new_run_id()
    user_persona_override = n_personas  # may be None
    max_turns = max_turns or settings.default_max_turns

    bus = create_bus(run_id, settings.runs_dir)
    run_dir = settings.runs_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    writer = RunWriter(run_dir)
    stage_timings: list[tuple[str, float]] = []

    t0 = time.monotonic()
    settings_summary = {
        "opus_model": settings.opus_model_id,
        "sonnet_model": settings.sonnet_model_id,
        "parallel_persona_limit": settings.parallel_persona_limit,
        "parallel_section_limit": settings.parallel_section_limit,
        "enable_verifier": settings.enable_verifier,
        "browser_use_cloud": bool(settings.browser_use_api_key),
        "browser_use_timeout_s": settings.browser_use_timeout_s,
    }
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    dataset_schema = schema_summary()

    # 0. Question analysis (decide panel size + seed perspectives)
    await bus.emit(SSEEvent(type="stage_started", run_id=run_id, data={"stage": "question_analysis"}))
    t_stage = time.monotonic()
    plan = await analyze_question(client, question, persona_override=user_persona_override)
    n_personas = plan.recommended_personas
    writer.write_question(question, n_personas, max_turns, settings_summary)
    writer.write_question_plan(plan, user_override=user_persona_override)
    elapsed_qa = round(time.monotonic() - t_stage, 1)
    stage_timings.append(("question_analysis", elapsed_qa))
    logger.info(
        "stage question_analysis done in %ss — complexity=%s score=%d → %d personas (override=%s)",
        elapsed_qa, plan.complexity, plan.complexity_score, n_personas, user_persona_override,
    )
    await bus.emit(
        SSEEvent(
            type="run_started",
            run_id=run_id,
            data={
                "question": question,
                "personas": n_personas,
                "max_turns": max_turns,
            },
        )
    )
    await bus.emit(
        SSEEvent(
            type="question_plan",
            run_id=run_id,
            data={
                "complexity": plan.complexity,
                "complexity_score": plan.complexity_score,
                "recommended_personas": plan.recommended_personas,
                "user_override": user_persona_override,
                "axes": plan.axes,
                "n_seeds": len(plan.must_have_perspectives),
                "rationale": plan.rationale,
            },
        )
    )
    await bus.emit(SSEEvent(
        type="stage_completed", run_id=run_id,
        data={
            "stage": "question_analysis",
            "elapsed_s": elapsed_qa,
            "complexity": plan.complexity,
            "n_personas": n_personas,
        },
    ))

    try:
        # 1. Personas
        await bus.emit(SSEEvent(type="stage_started", run_id=run_id, data={"stage": "personas"}))
        t_stage = time.monotonic()
        personas = await generate_personas(
            client, question, n_personas, plan=plan, debug_dir=run_dir / "debug",
        )
        for p in personas:
            await bus.emit(
                SSEEvent(
                    type="persona_created",
                    run_id=run_id,
                    persona_id=p.id,
                    data=p.model_dump(),
                )
            )
        writer.write_personas(personas)
        elapsed_personas = round(time.monotonic() - t_stage, 1)
        stage_timings.append(("personas", elapsed_personas))
        # Panel is analyst-only by design; we still tally persona_type in case a
        # future experiment re-enables synthetic consumer personas.
        type_counts = {"consumer": 0, "expert": 0}
        for p in personas:
            type_counts[p.persona_type] = type_counts.get(p.persona_type, 0) + 1
        logger.info(
            "stage personas done in %ss — %d analysts (%s)",
            elapsed_personas, len(personas),
            ", ".join(f"{k}={v}" for k, v in type_counts.items() if v),
        )
        await bus.emit(SSEEvent(
            type="stage_completed", run_id=run_id,
            data={
                "stage": "personas",
                "elapsed_s": elapsed_personas,
                "n_personas": len(personas),
                "type_counts": type_counts,
            },
        ))

        # 2. Seed outline + section assignments
        await bus.emit(SSEEvent(type="stage_started", run_id=run_id, data={"stage": "outline"}))
        t_stage = time.monotonic()
        executive_intent, seed_sections = await draft_seed_outline(
            client, question, personas, dataset_schema
        )
        await bus.emit(
            SSEEvent(
                type="seed_outline",
                run_id=run_id,
                data={
                    "executive_intent": executive_intent,
                    "sections": [s.model_dump() for s in seed_sections],
                },
            )
        )
        assignments = await assign_sections(client, question, personas, seed_sections)
        personas = [
            p.model_copy(update={"section_assignments": assignments.get(p.id, [])})
            for p in personas
        ]
        for p in personas:
            await bus.emit(
                SSEEvent(
                    type="persona_assigned",
                    run_id=run_id,
                    persona_id=p.id,
                    data={"sections": p.section_assignments},
                )
            )
        writer.write_seed_outline(executive_intent, seed_sections, assignments, personas)
        elapsed_outline = round(time.monotonic() - t_stage, 1)
        stage_timings.append(("outline", elapsed_outline))
        logger.info(
            "stage outline done in %ss — %d sections drafted, assignments=%s",
            elapsed_outline, len(seed_sections),
            {pid: len(hs) for pid, hs in assignments.items()},
        )
        await bus.emit(SSEEvent(
            type="stage_completed", run_id=run_id,
            data={
                "stage": "outline",
                "elapsed_s": elapsed_outline,
                "n_sections": len(seed_sections),
            },
        ))

        # 3. Parallel interviews
        await bus.emit(SSEEvent(type="stage_started", run_id=run_id, data={"stage": "interviews"}))
        t_stage = time.monotonic()
        sem = asyncio.Semaphore(settings.parallel_persona_limit)

        async def _persona_task(p: Persona) -> SubReport:
            async with sem:
                return await _interview_persona(
                    client=client,
                    bus=bus,
                    run_id=run_id,
                    question=question,
                    persona=p,
                    dataset_schema=dataset_schema,
                    max_turns=max_turns,
                    writer=writer,
                )

        results = await asyncio.gather(
            *[_persona_task(p) for p in personas],
            return_exceptions=True,
        )
        sub_reports: list[SubReport] = []
        for p, r in zip(personas, results):
            if isinstance(r, Exception):
                logger.exception("persona %s failed", p.id, exc_info=r)
                await bus.emit(
                    SSEEvent(
                        type="error",
                        run_id=run_id,
                        persona_id=p.id,
                        data={"message": str(r)},
                    )
                )
                continue
            sub_reports.append(r)
        if not sub_reports:
            raise RuntimeError("All personas failed; no sub-reports to synthesize.")
        writer.write_subreports(sub_reports)
        elapsed_interviews = round(time.monotonic() - t_stage, 1)
        stage_timings.append(("interviews", elapsed_interviews))
        total_cites = sum(len(s.citations) for s in sub_reports)
        logger.info(
            "stage interviews done in %ss — %d/%d personas succeeded, %d total citations",
            elapsed_interviews, len(sub_reports), n_personas, total_cites,
        )
        await bus.emit(SSEEvent(
            type="stage_completed", run_id=run_id,
            data={
                "stage": "interviews",
                "elapsed_s": elapsed_interviews,
                "successful": len(sub_reports),
                "failed": n_personas - len(sub_reports),
                "total_citations": total_cites,
            },
        ))

        # 4. Verifier (re-run [Q?] SQL in parallel)
        verified = 0
        flagged = 0
        if settings.enable_verifier:
            await bus.emit(SSEEvent(type="stage_started", run_id=run_id, data={"stage": "verifier"}))
            t_stage = time.monotonic()
            sub_reports = await verify_subreports(sub_reports)
            verified = sum(
                1 for s in sub_reports for c in s.citations if c.verified is True
            )
            flagged = sum(
                1 for s in sub_reports for c in s.citations if c.verified is False
            )
            writer.write_verifier(sub_reports)
            elapsed_v = round(time.monotonic() - t_stage, 1)
            stage_timings.append(("verifier", elapsed_v))
            logger.info(
                "stage verifier done in %ss — %d ✓ verified, %d ⚠ flagged",
                elapsed_v, verified, flagged,
            )
            await bus.emit(SSEEvent(
                type="stage_completed", run_id=run_id,
                data={
                    "stage": "verifier",
                    "elapsed_s": elapsed_v,
                    "verified": verified,
                    "flagged": flagged,
                },
            ))

        # 5. Synthesis (parallel section writers + evidence appendix)
        await bus.emit(SSEEvent(
            type="outline_started",
            run_id=run_id,
            data={"n_subreports": len(sub_reports)},
        ))
        await bus.emit(SSEEvent(type="stage_started", run_id=run_id, data={"stage": "synthesis"}))
        t_stage = time.monotonic()
        final = await synthesize(
            client,
            question,
            sub_reports,
            seed_sections=seed_sections,
            executive_intent=executive_intent,
        )

        (run_dir / "final.md").write_text(final.markdown)
        (run_dir / "final.json").write_text(final.model_dump_json(indent=2))
        writer.write_final_outline(
            final.outline[0] if final.outline else "",
            final.outline[1:] if len(final.outline) > 1 else [],
        )
        elapsed_syn = round(time.monotonic() - t_stage, 1)
        stage_timings.append(("synthesis", elapsed_syn))
        logger.info(
            "stage synthesis done in %ss — %d sections, %d citations, %d chars",
            elapsed_syn, len(final.outline), len(final.citations), len(final.markdown),
        )
        await bus.emit(SSEEvent(
            type="stage_completed", run_id=run_id,
            data={"stage": "synthesis", "elapsed_s": elapsed_syn},
        ))

        total_elapsed = round(time.monotonic() - t0, 1)
        writer.write_run_summary(
            question=question,
            elapsed_s=total_elapsed,
            n_personas=len(personas),
            n_subreports=len(sub_reports),
            n_citations=len(final.citations),
            verified=verified,
            flagged=flagged,
            n_reactions=0,  # challenge round removed
            stage_timings=stage_timings,
        )
        writer.write_index()
        logger.info(
            "run %s complete in %ss — %d citations (%d ✓, %d ⚠)",
            run_id, total_elapsed, len(final.citations), verified, flagged,
        )
        await bus.emit(
            SSEEvent(
                type="final_ready",
                run_id=run_id,
                data={
                    "markdown_len": len(final.markdown),
                    "n_citations": len(final.citations),
                    "n_sections": len(final.outline),
                    "elapsed_s": total_elapsed,
                },
            )
        )
        return final
    except Exception as e:
        logger.exception("Run %s failed", run_id)
        await bus.emit(
            SSEEvent(type="error", run_id=run_id, data={"message": str(e)})
        )
        raise
    finally:
        await bus.close()


async def _interview_persona(
    client: AsyncAnthropic,
    bus: EventBus,
    run_id: str,
    question: str,
    persona: Persona,
    dataset_schema: str,
    max_turns: int,
    writer: RunWriter | None = None,
) -> SubReport:
    memory = DialogueMemory()
    interviewer = Interviewer(client, persona, question, memory)
    perspective = PerspectiveAgent(client, persona, question, dataset_schema)

    turns: list[DialogueTurn] = []
    for t in range(1, max_turns + 1):
        q = await interviewer.next_question()
        if q is None:
            await bus.emit(
                SSEEvent(
                    type="interviewer_stopped",
                    run_id=run_id,
                    persona_id=persona.id,
                    turn_idx=t,
                    data={"reason": "checklist + sections covered"},
                )
            )
            break

        await bus.emit(
            SSEEvent(
                type="turn_started",
                run_id=run_id,
                persona_id=persona.id,
                turn_idx=t,
                data={"question": q},
            )
        )

        async def on_event(name: str, payload: dict[str, Any]) -> None:
            await bus.emit(
                SSEEvent(
                    type=name,
                    run_id=run_id,
                    persona_id=persona.id,
                    turn_idx=t,
                    data=payload,
                )
            )

        turn = await perspective.answer(q, memory, t, on_event=on_event)
        memory.append(turn)
        turns.append(turn)
        await memory.refresh_summary_if_needed(client)

        await bus.emit(
            SSEEvent(
                type="turn_completed",
                run_id=run_id,
                persona_id=persona.id,
                turn_idx=t,
                data={
                    "answer": turn.answer,
                    "n_citations": len(turn.citations),
                    "done": turn.done,
                },
            )
        )
        if turn.done:
            break

    sub_report = await draft_subreport(client, persona, question, turns)
    # Persist per-persona transcript + sub-report
    settings = get_settings()
    persona_dir = settings.runs_dir / run_id / persona.id
    persona_dir.mkdir(parents=True, exist_ok=True)
    (persona_dir / "transcript.json").write_text(
        "[" + ",\n".join(t.model_dump_json(indent=2) for t in turns) + "]"
    )
    (persona_dir / "subreport.md").write_text(sub_report.markdown)
    if writer is not None:
        writer.write_interview(persona, turns)
    logger.info(
        "interview %s done — %d turns, %d citations, headline=%r",
        persona.id, len(turns), len(sub_report.citations),
        (sub_report.headline_claim or "")[:100],
    )

    await bus.emit(
        SSEEvent(
            type="subreport_ready",
            run_id=run_id,
            persona_id=persona.id,
            data={
                "markdown_len": len(sub_report.markdown),
                "n_citations": len(sub_report.citations),
                "n_turns": len(turns),
                "headline_claim": sub_report.headline_claim,
            },
        )
    )
    return sub_report

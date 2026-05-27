"""Per-stage adapters for the research pipeline.

Each stage of the research DAG (question_analysis → personas → outline →
interviews → verifier → synthesis) is exposed here as a small async
function that operates on a shared :class:`StageContext`. The context
holds the cell's static config (question, run_id, settings, guardrails)
and the mutable outputs each stage produces (plan, personas,
sub_reports, final brief).

This module is the seam that lets two callers drive the same pipeline:

1. :func:`diageo_research.orchestrator.run_research` composes the
   stages sequentially in the parent event loop. This is the back-compat
   path used by ``POST /research`` and existing tests.
2. :mod:`diageo_research.dagster_assets` calls each stage from a
   ``@asset`` body running inside Dagster's executor. The asset bodies
   schedule the coroutine on the parent loop (where the bus and
   anthropic client live) via :func:`asyncio.run_coroutine_threadsafe`,
   so all I/O happens in the loop everything was originally constructed
   in.

This split keeps cross-loop plumbing out of the stage logic itself —
stages call ``await ctx.bus.emit(...)`` and ``await ctx.client.messages
.create(...)`` exactly as before. The asset bodies handle the threading
gymnastics.

The :class:`StageContext` is intentionally a plain dataclass-shaped
class (not pydantic). It holds runtime objects (``EventBus``,
``AsyncAnthropic``, ``CostTracker``) that don't serialise; we never
write it to disk.
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any

from .config import get_settings
from .events import EventBus, create_bus
from .granular_assets import emit_interview_granular, emit_synthesis_granular
from .interviewer import Interviewer
from .manifest import ManifestWriter
from .memory import DialogueMemory
from .models import (
    DialogueTurn,
    FinalReport,
    OutlineSection,
    Persona,
    SSEEvent,
    SubReport,
)
from .outline import assign_sections, draft_seed_outline
from .persona_generator import generate_personas
from .perspective import PerspectiveAgent
from .pricing import (
    CostTracker,
    MeteredAsyncAnthropic,
    persona_ctx,
    register_tracker,
    stage_ctx,
)
from .prompt_loader import PROMPT_DIR
from .question_analysis import analyze_question
from .question_analysis import QuestionPlan
from .run_writer import RunWriter
from .summarizer import draft_subreport, synthesize
from .tools.duckdb_tool import schema_summary
from .verifier import verify_subreports

logger = logging.getLogger(__name__)


def _load_prompt_safe(name: str) -> str:
    """Load a prompt template by name; empty string if missing.

    Used by the manifest writer to hash the prompt for a stage. Manifest
    writes never break the pipeline.
    """
    path = PROMPT_DIR / f"{name}.md"
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except Exception:  # noqa: BLE001
        return ""


# ----------------------------------------------------------- StageContext


class StageContext:
    """Shared mutable state across the stages of a single research run.

    Constructed once at the top of :func:`run_research` (or at the top
    of :func:`materialize_research_cell`) and mutated by each stage. The
    later stages read what the earlier stages produced — for example
    :func:`stage_outline` reads ``ctx.personas`` and writes
    ``ctx.seed_sections`` and ``ctx.assignments``.

    Attributes are split into:

    * **Static config** — set by ``__init__``, never mutated.
    * **Mutable stage outputs** — written by exactly one stage, read by
      later stages and by the partial-brief writer if the budget guard
      trips mid-run.
    * **Bookkeeping** — timings, persistent writers, cost tracker.
    """

    # ---- ctor ----------------------------------------------------------

    def __init__(
        self,
        *,
        question: str,
        run_id: str,
        user_persona_override: int | None,
        max_turns: int,
        eff_enable_web_browse: bool,
        eff_max_browses_per_cell: int,
        eff_max_cost_usd: float | None,
        bus: EventBus,
        run_dir: Path,
        writer: RunWriter,
        manifest: ManifestWriter,
        cost_tracker: CostTracker,
        client: MeteredAsyncAnthropic,
        settings_summary: dict[str, Any],
        dataset_schema: str,
        parent_loop: asyncio.AbstractEventLoop | None,
    ) -> None:
        # Static config
        self.question = question
        self.run_id = run_id
        self.user_persona_override = user_persona_override
        self.max_turns = max_turns
        self.eff_enable_web_browse = eff_enable_web_browse
        self.eff_max_browses_per_cell = eff_max_browses_per_cell
        self.eff_max_cost_usd = eff_max_cost_usd
        self.settings_summary = settings_summary
        self.dataset_schema = dataset_schema
        self.parent_loop = parent_loop

        # Long-lived infra
        self.bus = bus
        self.run_dir = run_dir
        self.writer = writer
        self.manifest = manifest
        self.cost_tracker = cost_tracker
        self.client = client

        # Mutable stage outputs (filled in as the pipeline progresses)
        self.plan: QuestionPlan | None = None
        self.n_personas: int = 0
        self.personas: list[Persona] = []
        self.executive_intent: str = ""
        self.seed_sections: list[OutlineSection] = []
        self.assignments: dict[str, list[str]] = {}
        self.sub_reports: list[SubReport] = []
        self.verified_count: int = 0
        self.flagged_count: int = 0
        self.final: FinalReport | None = None
        # Per-persona tool-call log captured during the interview stage
        # so the granular tool_call asset emit can reach it from
        # stage_synthesis (after global cite-id renumbering).
        self.tool_call_logs: dict[str, list[dict[str, Any]]] = {}

        # Optional Dagster instance for runless granular materialization
        # emits. The orchestrator sets this only when running via
        # ``materialize_research_cell``; the single-shot ``run_research``
        # path leaves it ``None`` so emits are no-ops.
        self.dagster_instance: Any = None
        # Optional axes mapping for content-addressed granular keys.
        # Single-shot runs leave this ``None`` (axes_signature falls back
        # to "no-axes" inside :mod:`diageo_research.keys`).
        self.axes: dict[str, str] | None = None

        # Bookkeeping
        self.t0 = time.monotonic()
        self.stage_timings: list[tuple[str, float]] = []


# ------------------------------------------------------------- Builders


def build_stage_context(
    *,
    question: str,
    run_id: str,
    n_personas: int | None = None,
    max_turns: int | None = None,
    enable_web_browse: bool | None = None,
    max_browses_per_cell: int | None = None,
    max_cost_usd: float | None = None,
    parent_loop: asyncio.AbstractEventLoop | None = None,
) -> StageContext:
    """Resolve settings + create the run dir, bus, writers, tracker, client.

    This is the one place that wires together every per-run resource so
    both ``run_research`` and ``materialize_research_cell`` build the
    same context shape. Side effects: creates the run directory, registers
    the cost tracker, creates the event bus.
    """
    settings = get_settings()
    user_persona_override = n_personas
    eff_max_turns = max_turns or settings.default_max_turns
    eff_enable_web_browse = (
        settings.enable_web_browse if enable_web_browse is None else bool(enable_web_browse)
    )
    eff_max_browses_per_cell = (
        settings.max_browses_per_cell
        if max_browses_per_cell is None
        else int(max_browses_per_cell)
    )
    eff_max_cost_usd = (
        settings.max_cost_usd if max_cost_usd is None else float(max_cost_usd)
    )

    bus = create_bus(run_id, settings.runs_dir)
    run_dir = settings.runs_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    writer = RunWriter(run_dir)
    manifest = ManifestWriter(run_dir, run_id)
    cost_tracker = CostTracker(run_dir, max_cost_usd=eff_max_cost_usd)
    register_tracker(run_id, cost_tracker)

    settings_summary = {
        "opus_model": settings.opus_model_id,
        "sonnet_model": settings.sonnet_model_id,
        "parallel_persona_limit": settings.parallel_persona_limit,
        "parallel_section_limit": settings.parallel_section_limit,
        "enable_verifier": settings.enable_verifier,
        "browser_use_cloud": bool(settings.browser_use_api_key),
        "browser_use_timeout_s": settings.browser_use_timeout_s,
        "enable_web_browse": eff_enable_web_browse,
        "max_browses_per_cell": eff_max_browses_per_cell,
        "max_cost_usd": eff_max_cost_usd,
    }

    client = MeteredAsyncAnthropic(api_key=settings.anthropic_api_key, run_id=run_id)
    dataset_schema = schema_summary()
    manifest.set_run_inputs(
        question=question,
        settings_summary=settings_summary,
        code_anchor_path=__file__,
    )

    return StageContext(
        question=question,
        run_id=run_id,
        user_persona_override=user_persona_override,
        max_turns=eff_max_turns,
        eff_enable_web_browse=eff_enable_web_browse,
        eff_max_browses_per_cell=eff_max_browses_per_cell,
        eff_max_cost_usd=eff_max_cost_usd,
        bus=bus,
        run_dir=run_dir,
        writer=writer,
        manifest=manifest,
        cost_tracker=cost_tracker,
        client=client,
        settings_summary=settings_summary,
        dataset_schema=dataset_schema,
        parent_loop=parent_loop,
    )


# ---------------------------------------------------------- Stage 0: question


async def stage_question_analysis(ctx: StageContext) -> None:
    """Score complexity, derive lens seeds, recommend panel size."""
    settings = get_settings()
    await ctx.bus.emit(
        SSEEvent(type="stage_started", run_id=ctx.run_id, data={"stage": "question_analysis"})
    )
    t_stage = time.monotonic()
    with stage_ctx("question_analysis"):
        plan = await analyze_question(
            ctx.client, ctx.question, persona_override=ctx.user_persona_override
        )
    ctx.plan = plan
    ctx.n_personas = plan.recommended_personas
    ctx.writer.write_question(
        ctx.question, ctx.n_personas, ctx.max_turns, ctx.settings_summary
    )
    ctx.writer.write_question_plan(plan, user_override=ctx.user_persona_override)
    elapsed = round(time.monotonic() - t_stage, 1)
    ctx.stage_timings.append(("question_analysis", elapsed))
    logger.info(
        "stage question_analysis done in %ss — complexity=%s score=%d → %d personas (override=%s)",
        elapsed, plan.complexity, plan.complexity_score, ctx.n_personas, ctx.user_persona_override,
    )
    await ctx.bus.emit(
        SSEEvent(
            type="run_started",
            run_id=ctx.run_id,
            data={
                "question": ctx.question,
                "personas": ctx.n_personas,
                "max_turns": ctx.max_turns,
            },
        )
    )
    await ctx.bus.emit(
        SSEEvent(
            type="question_plan",
            run_id=ctx.run_id,
            data={
                "complexity": plan.complexity,
                "complexity_score": plan.complexity_score,
                "recommended_personas": plan.recommended_personas,
                "user_override": ctx.user_persona_override,
                "axes": plan.axes,
                "n_seeds": len(plan.must_have_perspectives),
                "rationale": plan.rationale,
            },
        )
    )
    ctx.manifest.write_stage(
        "question_analysis",
        elapsed_s=elapsed,
        inputs={"question": ctx.question, "persona_override": ctx.user_persona_override},
        prompt=_load_prompt_safe("question_analysis"),
        model_id=settings.opus_model_id,
        outputs=plan.model_dump(),
        code_path=str(Path(__file__).parent / "question_analysis.py"),
        extras={"complexity": plan.complexity, "n_personas": ctx.n_personas},
    )
    await ctx.bus.emit(
        SSEEvent(
            type="stage_completed",
            run_id=ctx.run_id,
            data={
                "stage": "question_analysis",
                "elapsed_s": elapsed,
                "complexity": plan.complexity,
                "n_personas": ctx.n_personas,
            },
        )
    )


# --------------------------------------------------------- Stage 1: personas


async def stage_personas(ctx: StageContext) -> None:
    """Generate the analyst panel based on the question plan."""
    if ctx.plan is None:
        raise RuntimeError("stage_personas requires question_analysis to have run first")
    settings = get_settings()
    await ctx.bus.emit(
        SSEEvent(type="stage_started", run_id=ctx.run_id, data={"stage": "personas"})
    )
    t_stage = time.monotonic()
    with stage_ctx("personas"):
        personas = await generate_personas(
            ctx.client,
            ctx.question,
            ctx.n_personas,
            plan=ctx.plan,
            debug_dir=ctx.run_dir / "debug",
        )
    ctx.personas = personas
    for p in personas:
        await ctx.bus.emit(
            SSEEvent(
                type="persona_created",
                run_id=ctx.run_id,
                persona_id=p.id,
                data=p.model_dump(),
            )
        )
    ctx.writer.write_personas(personas)
    elapsed = round(time.monotonic() - t_stage, 1)
    ctx.stage_timings.append(("personas", elapsed))
    type_counts = {"consumer": 0, "expert": 0}
    for p in personas:
        type_counts[p.persona_type] = type_counts.get(p.persona_type, 0) + 1
    logger.info(
        "stage personas done in %ss — %d analysts (%s)",
        elapsed, len(personas),
        ", ".join(f"{k}={v}" for k, v in type_counts.items() if v),
    )
    ctx.manifest.write_stage(
        "personas",
        elapsed_s=elapsed,
        inputs={
            "question": ctx.question,
            "n_personas": ctx.n_personas,
            "plan": ctx.plan.model_dump(),
        },
        prompt=_load_prompt_safe("persona_gen"),
        model_id=settings.opus_model_id,
        outputs=[p.model_dump() for p in personas],
        code_path=str(Path(__file__).parent / "persona_generator.py"),
        extras={"type_counts": type_counts},
    )
    await ctx.bus.emit(
        SSEEvent(
            type="stage_completed",
            run_id=ctx.run_id,
            data={
                "stage": "personas",
                "elapsed_s": elapsed,
                "n_personas": len(personas),
                "type_counts": type_counts,
            },
        )
    )


# ---------------------------------------------------------- Stage 2: outline


async def stage_outline(ctx: StageContext) -> None:
    """Draft the seed outline + assign sections to personas."""
    if not ctx.personas:
        raise RuntimeError("stage_outline requires personas to be populated")
    settings = get_settings()
    await ctx.bus.emit(
        SSEEvent(type="stage_started", run_id=ctx.run_id, data={"stage": "outline"})
    )
    t_stage = time.monotonic()
    with stage_ctx("outline"):
        executive_intent, seed_sections = await draft_seed_outline(
            ctx.client, ctx.question, ctx.personas, ctx.dataset_schema
        )
    ctx.executive_intent = executive_intent
    ctx.seed_sections = seed_sections
    await ctx.bus.emit(
        SSEEvent(
            type="seed_outline",
            run_id=ctx.run_id,
            data={
                "executive_intent": executive_intent,
                "sections": [s.model_dump() for s in seed_sections],
            },
        )
    )
    with stage_ctx("outline"):
        assignments = await assign_sections(
            ctx.client, ctx.question, ctx.personas, seed_sections
        )
    ctx.assignments = assignments
    # Carry section assignments back onto the persona objects so
    # downstream stages (interviews, synthesis) can read them off the
    # Persona directly.
    ctx.personas = [
        p.model_copy(update={"section_assignments": assignments.get(p.id, [])})
        for p in ctx.personas
    ]
    for p in ctx.personas:
        await ctx.bus.emit(
            SSEEvent(
                type="persona_assigned",
                run_id=ctx.run_id,
                persona_id=p.id,
                data={"sections": p.section_assignments},
            )
        )
    ctx.writer.write_seed_outline(
        executive_intent, seed_sections, assignments, ctx.personas
    )
    elapsed = round(time.monotonic() - t_stage, 1)
    ctx.stage_timings.append(("outline", elapsed))
    logger.info(
        "stage outline done in %ss — %d sections drafted, assignments=%s",
        elapsed, len(seed_sections),
        {pid: len(hs) for pid, hs in assignments.items()},
    )
    ctx.manifest.write_stage(
        "outline",
        elapsed_s=elapsed,
        inputs={
            "question": ctx.question,
            "personas": [p.id for p in ctx.personas],
        },
        prompt=_load_prompt_safe("outline_seed"),
        model_id=settings.opus_model_id,
        outputs={
            "executive_intent": executive_intent,
            "sections": [s.model_dump() for s in seed_sections],
            "assignments": assignments,
        },
        code_path=str(Path(__file__).parent / "outline.py"),
    )
    await ctx.bus.emit(
        SSEEvent(
            type="stage_completed",
            run_id=ctx.run_id,
            data={
                "stage": "outline",
                "elapsed_s": elapsed,
                "n_sections": len(seed_sections),
            },
        )
    )


# ------------------------------------------------------- Stage 3: interviews


async def stage_interviews(ctx: StageContext) -> None:
    """Per-persona STORM interviews + sub-report synthesis (parallel)."""
    if not ctx.personas:
        raise RuntimeError("stage_interviews requires personas to be populated")
    settings = get_settings()
    await ctx.bus.emit(
        SSEEvent(type="stage_started", run_id=ctx.run_id, data={"stage": "interviews"})
    )
    t_stage = time.monotonic()
    sem = asyncio.Semaphore(settings.parallel_persona_limit)

    async def _persona_task(
        p: Persona,
    ) -> tuple[SubReport, list[DialogueTurn], list[dict[str, Any]], dict[str, Any]]:
        async with sem:
            with stage_ctx("interviews"), persona_ctx(p.id):
                return await _interview_persona(
                    client=ctx.client,
                    bus=ctx.bus,
                    run_id=ctx.run_id,
                    question=ctx.question,
                    persona=p,
                    dataset_schema=ctx.dataset_schema,
                    max_turns=ctx.max_turns,
                    writer=ctx.writer,
                    enable_web_browse=ctx.eff_enable_web_browse,
                    max_browses_per_cell=ctx.eff_max_browses_per_cell,
                )

    results = await asyncio.gather(
        *[_persona_task(p) for p in ctx.personas],
        return_exceptions=True,
    )
    sub_reports: list[SubReport] = []
    per_persona_payloads: list[
        tuple[Persona, SubReport, list[DialogueTurn], list[dict[str, Any]], dict[str, Any]]
    ] = []
    for p, r in zip(ctx.personas, results):
        if isinstance(r, Exception):
            logger.exception("persona %s failed", p.id, exc_info=r)
            await ctx.bus.emit(
                SSEEvent(
                    type="error",
                    run_id=ctx.run_id,
                    persona_id=p.id,
                    data={"message": str(r)},
                )
            )
            continue
        sub_report, turns, tool_calls, telemetry = r
        sub_reports.append(sub_report)
        per_persona_payloads.append((p, sub_report, turns, tool_calls, telemetry))
        ctx.tool_call_logs[p.id] = tool_calls
    if not sub_reports:
        raise RuntimeError("All personas failed; no sub-reports to synthesize.")
    ctx.sub_reports = sub_reports
    ctx.writer.write_subreports(sub_reports)

    # Emit granular per-persona / per-turn / per-tool_call asset
    # materializations now that every parallel interview has landed.
    # Wrap in try/except so a Dagster instance hiccup never fails the
    # interview stage — the receipts are best-effort observability.
    if ctx.dagster_instance is not None:
        try:
            per_persona_costs = (
                (ctx.cost_tracker.to_json().get("by_persona") or {})
                if ctx.cost_tracker is not None
                else {}
            )
            for p, sub_report, turns, tool_calls, telemetry in per_persona_payloads:
                cost_row = per_persona_costs.get(p.id) or {}
                emit_interview_granular(
                    ctx.dagster_instance,
                    ctx=ctx,
                    persona=p,
                    sub_report=sub_report,
                    turns=turns,
                    tool_calls=tool_calls,
                    persona_cost_usd=cost_row.get("cost_usd"),
                    started_at=telemetry.get("started_at"),
                    finished_at=telemetry.get("finished_at"),
                    turn_timings=telemetry.get("turn_timings"),
                )
        except Exception:  # noqa: BLE001
            logger.exception(
                "granular interview materialization emission failed for run %s",
                ctx.run_id,
            )
    elapsed = round(time.monotonic() - t_stage, 1)
    ctx.stage_timings.append(("interviews", elapsed))
    total_cites = sum(len(s.citations) for s in sub_reports)
    logger.info(
        "stage interviews done in %ss — %d/%d personas succeeded, %d total citations",
        elapsed, len(sub_reports), ctx.n_personas, total_cites,
    )
    ctx.manifest.write_stage(
        "interviews",
        elapsed_s=elapsed,
        inputs={
            "personas": [p.id for p in ctx.personas],
            "max_turns": ctx.max_turns,
        },
        prompt=_load_prompt_safe("interviewer") + "\n---\n" + _load_prompt_safe("perspective"),
        model_id=settings.sonnet_model_id,
        outputs={
            "headlines": [
                {"persona_id": s.persona_id, "headline": s.headline_claim}
                for s in sub_reports
            ],
            "n_subreports": len(sub_reports),
            "total_citations": total_cites,
        },
        code_path=str(Path(__file__).parent / "perspective.py"),
        extras={"successful": len(sub_reports), "failed": ctx.n_personas - len(sub_reports)},
    )
    await ctx.bus.emit(
        SSEEvent(
            type="stage_completed",
            run_id=ctx.run_id,
            data={
                "stage": "interviews",
                "elapsed_s": elapsed,
                "successful": len(sub_reports),
                "failed": ctx.n_personas - len(sub_reports),
                "total_citations": total_cites,
            },
        )
    )


# --------------------------------------------------------- Stage 4: verifier


async def stage_verifier(ctx: StageContext) -> None:
    """Re-execute SQL/web citations to flag broken provenance."""
    settings = get_settings()
    if not settings.enable_verifier:
        # Skip cleanly; downstream readers see verified_count=0 / flagged_count=0.
        ctx.verified_count = 0
        ctx.flagged_count = 0
        return
    await ctx.bus.emit(
        SSEEvent(type="stage_started", run_id=ctx.run_id, data={"stage": "verifier"})
    )
    t_stage = time.monotonic()
    with stage_ctx("verifier"):
        ctx.sub_reports = await verify_subreports(ctx.sub_reports)
    ctx.verified_count = sum(
        1 for s in ctx.sub_reports for c in s.citations if c.verified is True
    )
    ctx.flagged_count = sum(
        1 for s in ctx.sub_reports for c in s.citations if c.verified is False
    )
    ctx.writer.write_verifier(ctx.sub_reports)
    elapsed = round(time.monotonic() - t_stage, 1)
    ctx.stage_timings.append(("verifier", elapsed))
    logger.info(
        "stage verifier done in %ss — %d ✓ verified, %d ⚠ flagged",
        elapsed, ctx.verified_count, ctx.flagged_count,
    )
    ctx.manifest.write_stage(
        "verifier",
        elapsed_s=elapsed,
        inputs={"n_subreports": len(ctx.sub_reports)},
        model_id="duckdb",
        outputs={"verified": ctx.verified_count, "flagged": ctx.flagged_count},
        code_path=str(Path(__file__).parent / "verifier.py"),
    )
    await ctx.bus.emit(
        SSEEvent(
            type="stage_completed",
            run_id=ctx.run_id,
            data={
                "stage": "verifier",
                "elapsed_s": elapsed,
                "verified": ctx.verified_count,
                "flagged": ctx.flagged_count,
            },
        )
    )


# -------------------------------------------------------- Stage 5: synthesis


async def stage_synthesis(ctx: StageContext) -> None:
    """Final brief: parallel section writers + charts + evidence appendix."""
    if not ctx.sub_reports:
        raise RuntimeError("stage_synthesis requires sub_reports to be populated")
    settings = get_settings()
    await ctx.bus.emit(
        SSEEvent(
            type="outline_started",
            run_id=ctx.run_id,
            data={"n_subreports": len(ctx.sub_reports)},
        )
    )
    await ctx.bus.emit(
        SSEEvent(type="stage_started", run_id=ctx.run_id, data={"stage": "synthesis"})
    )
    t_stage = time.monotonic()
    with stage_ctx("synthesis"):
        final = await synthesize(
            ctx.client,
            ctx.question,
            ctx.sub_reports,
            seed_sections=ctx.seed_sections,
            executive_intent=ctx.executive_intent,
        )
    ctx.final = final
    (ctx.run_dir / "final.md").write_text(final.markdown)
    (ctx.run_dir / "final.json").write_text(final.model_dump_json(indent=2))
    ctx.writer.write_final_outline(
        final.outline[0] if final.outline else "",
        final.outline[1:] if len(final.outline) > 1 else [],
    )
    elapsed = round(time.monotonic() - t_stage, 1)
    ctx.stage_timings.append(("synthesis", elapsed))
    logger.info(
        "stage synthesis done in %ss — %d sections, %d citations, %d chars",
        elapsed, len(final.outline), len(final.citations), len(final.markdown),
    )

    # Emit citation + claim asset materializations. We hand the synth
    # the per-persona tool-call log captured during the interviews stage
    # so each citation asset can point back at the originating tool
    # call. Failure here never breaks synthesis — the brief is canonical.
    if ctx.dagster_instance is not None:
        try:
            emit_synthesis_granular(
                ctx.dagster_instance,
                ctx=ctx,
                final_report=final,
                sub_reports=ctx.sub_reports,
                tool_call_logs=ctx.tool_call_logs,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "granular synthesis materialization emission failed for run %s",
                ctx.run_id,
            )
    ctx.manifest.write_stage(
        "synthesis",
        elapsed_s=elapsed,
        inputs={
            "question": ctx.question,
            "n_subreports": len(ctx.sub_reports),
            "n_sections": len(ctx.seed_sections),
        },
        prompt=(
            _load_prompt_safe("summarizer_outline")
            + "\n---\n"
            + _load_prompt_safe("summarizer_section")
        ),
        model_id=settings.opus_model_id,
        outputs={
            "n_sections": len(final.outline),
            "n_citations": len(final.citations),
            "markdown_len": len(final.markdown),
        },
        code_path=str(Path(__file__).parent / "summarizer.py"),
    )
    await ctx.bus.emit(
        SSEEvent(
            type="stage_completed",
            run_id=ctx.run_id,
            data={"stage": "synthesis", "elapsed_s": elapsed},
        )
    )


# --------------------------------------------------- Per-persona interview


async def _interview_persona(
    client: Any,
    bus: EventBus,
    run_id: str,
    question: str,
    persona: Persona,
    dataset_schema: str,
    max_turns: int,
    writer: RunWriter | None = None,
    *,
    enable_web_browse: bool | None = None,
    max_browses_per_cell: int | None = None,
) -> tuple[SubReport, list[DialogueTurn], list[dict[str, Any]], dict[str, Any]]:
    """Run one persona's interview and return everything needed for granular asset emit.

    Returns ``(sub_report, turns, tool_call_log, telemetry)``. The
    ``telemetry`` dict carries per-turn timing (``turn_timings``), the
    persona-level wall-clock window, and the raw tool-call log so the
    caller can emit per-persona / per-turn / per-tool_call Dagster
    materializations after the gather completes.
    """
    import datetime as _dt

    def _now_iso() -> str:
        return _dt.datetime.now(tz=_dt.timezone.utc).isoformat()

    persona_started_at = _now_iso()
    persona_t0 = time.monotonic()

    memory = DialogueMemory()
    interviewer = Interviewer(client, persona, question, memory)
    perspective = PerspectiveAgent(
        client,
        persona,
        question,
        dataset_schema,
        enable_web_browse=enable_web_browse,
        max_browses_per_cell=max_browses_per_cell,
    )

    turns: list[DialogueTurn] = []
    turn_timings: dict[int, tuple[str | None, str | None, float | None]] = {}
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

        turn_started_at = _now_iso()
        turn_t0 = time.monotonic()
        turn = await perspective.answer(q, memory, t, on_event=on_event)
        turn_latency = round(max(0.0, time.monotonic() - turn_t0), 3)
        turn_finished_at = _now_iso()
        turn_timings[t] = (turn_started_at, turn_finished_at, turn_latency)
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
    settings = get_settings()
    persona_dir = settings.runs_dir / run_id / persona.id
    persona_dir.mkdir(parents=True, exist_ok=True)
    (persona_dir / "transcript.json").write_text(
        "[" + ",\n".join(t.model_dump_json(indent=2) for t in turns) + "]"
    )
    (persona_dir / "subreport.md").write_text(sub_report.markdown)
    tool_calls_snapshot: list[dict[str, Any]] = list(
        perspective.registry.tool_call_log
    )
    try:
        import json as _json

        tools_payload = {
            "persona_id": persona.id,
            "calls": tool_calls_snapshot,
        }
        (persona_dir / "tools.json").write_text(
            _json.dumps(tools_payload, indent=2, default=str), encoding="utf-8"
        )
    except Exception:  # noqa: BLE001
        logger.debug("tools.json persist failed for %s", persona.id, exc_info=True)
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
    telemetry: dict[str, Any] = {
        "started_at": persona_started_at,
        "finished_at": _now_iso(),
        "wall_time_s": round(max(0.0, time.monotonic() - persona_t0), 3),
        "turn_timings": turn_timings,
    }
    return sub_report, turns, tool_calls_snapshot, telemetry


# ------------------------------------------------------ Partial brief writer


def render_partial_brief(
    *,
    question: str,
    personas: list[Persona],
    sub_reports: list[SubReport],
    seed_sections: list[OutlineSection],
    spent: float,
    limit: float,
    cost_breakdown: dict[str, Any],
) -> str:
    """Build a 'budget-exceeded, here's what we got' brief.

    Surfaces the headlines from every completed sub-report, lists the
    seed-outline sections that would have been written, and shows where
    the spend went so the user can right-size the next run. The file is
    written to ``final.md`` so the workbench Brief tab still has
    something to render — the cell's status remains ``error`` so it can
    never be confused for a real finished brief.
    """
    overshoot = max(0.0, spent - limit)
    overshoot_pct = (overshoot / limit * 100) if limit > 0 else 0.0
    lines: list[str] = [
        f"# Strategy brief — {question}",
        "",
        "## ⚠️ Budget exhausted — partial brief",
        "",
        (
            f"This cell stopped early because cumulative Anthropic spend "
            f"reached **${spent:.4f}**, which is over the configured "
            f"`max_cost_usd` ceiling of **${limit:.4f}** "
            f"(+${overshoot:.4f}, {overshoot_pct:.1f}% over)."
        ),
        "",
        "**What is below this notice is real but incomplete.** The interviews "
        "that finished are summarised; the synthesis and executive answer "
        "were not produced. To regenerate this cell with a complete brief, "
        "raise `--max-cost` (or `defaults.max_cost_usd` in the spec yaml) — "
        "the empirical floor for the current `n_personas × max_turns × "
        "section count` configuration is shown in the spend breakdown below.",
        "",
    ]
    by_stage = (cost_breakdown or {}).get("by_stage") or {}
    if by_stage:
        lines.extend([
            "### Where the spend went (USD)",
            "",
            "| Stage | Calls | Spend |",
            "|---|---:|---:|",
        ])
        for stage_name in [
            "question_analysis",
            "personas",
            "outline",
            "interviews",
            "verifier",
            "synthesis",
        ]:
            if stage_name not in by_stage:
                continue
            row = by_stage[stage_name]
            lines.append(
                f"| {stage_name} | {int(row.get('n_calls') or 0)} | "
                f"${float(row.get('cost_usd') or 0):.4f} |"
            )
        lines.append(f"| **total recorded** | — | **${spent:.4f}** |")
        lines.append("")

    if personas:
        lines.append("### Panel that ran")
        lines.append("")
        for p in personas:
            lines.append(f"- **{p.id}** — {p.name} ({p.role}) · _{p.persona_type}_")
        lines.append("")

    if sub_reports:
        lines.append("## Sub-report headlines (from interviews that finished)")
        lines.append("")
        for s in sub_reports:
            head = (s.headline_claim or "(no headline produced)").strip()
            lines.append(f"### {s.persona_id} · {s.persona_name}")
            lines.append("")
            lines.append(head)
            lines.append("")
            if s.markdown:
                lines.append("<details><summary>Full sub-report</summary>")
                lines.append("")
                lines.append(s.markdown)
                lines.append("")
                lines.append("</details>")
                lines.append("")
    else:
        lines.append("## Sub-reports")
        lines.append("")
        lines.append(
            "_No sub-reports were drafted before the budget tripped — interviews "
            "did not finish for any persona._"
        )
        lines.append("")

    if seed_sections:
        lines.append("### Sections that would have been synthesised")
        lines.append("")
        for s in seed_sections:
            lines.append(f"- {s.heading}")
        lines.append("")

    return "\n".join(lines)


__all__ = [
    "StageContext",
    "build_stage_context",
    "render_partial_brief",
    "stage_interviews",
    "stage_outline",
    "stage_personas",
    "stage_question_analysis",
    "stage_synthesis",
    "stage_verifier",
]

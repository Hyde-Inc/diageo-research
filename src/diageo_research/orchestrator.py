"""Top-level pipeline composition.

Two entry points share the same per-stage adapters in
:mod:`diageo_research.stages`:

* :func:`run_research` — sequential async composition. The original,
  simplest path. Used by ``POST /research`` and unit tests.
* :func:`materialize_research_cell` — runs the same stages through
  Dagster's executor so the declared :class:`Definitions` graph is the
  one driving execution. Used by the multiverse runner so each cell
  records :class:`AssetMaterialization` events into a Dagster instance
  with the cell id as the dynamic partition key.

Both paths build the exact same :class:`StageContext`, so the per-stage
behaviour is bit-for-bit identical regardless of which executor runs
the pipeline.

Pipeline order::

  question_analysis (Opus) → personas (Opus) → outline (Opus + Sonnet)
    → interviews (Sonnet, parallel per-persona) → verifier (DuckDB)
    → synthesis (Opus, parallel section writers)

Why the executor is split via the worker thread in
:func:`materialize_research_cell` is documented inline. The short
version: ``dagster.materialize`` is a sync function that wants its own
event loop, so we hand it one in a thread while the parent FastAPI
loop continues to drive the bus, anthropic client, and SSE streams in
its own loop. The asset bodies in :mod:`dagster_assets` schedule
coroutines back onto the parent loop, keeping all I/O in the loop they
were originally constructed in.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from pathlib import Path
from typing import Any

from .config import get_settings
from .models import FinalReport, SSEEvent
from .pricing import (
    BudgetExceeded,
    drop_tracker,
    run_ctx,
)
from .stages import (
    StageContext,
    build_stage_context,
    render_partial_brief,
    stage_interviews,
    stage_outline,
    stage_personas,
    stage_question_analysis,
    stage_synthesis,
    stage_verifier,
)

logger = logging.getLogger(__name__)


def new_run_id() -> str:
    return uuid.uuid4().hex[:12]


# ----------------------------------------------------------- Sync composition


async def run_research(
    question: str,
    run_id: str | None = None,
    n_personas: int | None = None,
    max_turns: int | None = None,
    *,
    enable_web_browse: bool | None = None,
    max_browses_per_cell: int | None = None,
    max_cost_usd: float | None = None,
) -> FinalReport:
    """Run the multi-perspective research pipeline as a sequential
    async composition over the per-stage adapters in :mod:`stages`.

    Cost guardrails (all optional, all override settings when supplied):
      - ``enable_web_browse``: master toggle; when False, web_browse
        calls short-circuit to a hint and never spawn a browser.
      - ``max_browses_per_cell``: hard cap on browse calls across the run.
      - ``max_cost_usd``: dollar ceiling. Crossing it raises
        :class:`pricing.BudgetExceeded` mid-run; the cell is marked
        errored with a clear reason instead of bleeding budget silently.
    """
    run_id = run_id or new_run_id()
    settings = get_settings()
    parent_loop = asyncio.get_running_loop()
    ctx = build_stage_context(
        question=question,
        run_id=run_id,
        n_personas=n_personas,
        max_turns=max_turns,
        enable_web_browse=enable_web_browse,
        max_browses_per_cell=max_browses_per_cell,
        max_cost_usd=max_cost_usd,
        parent_loop=parent_loop,
    )

    run_token = run_ctx(run_id)
    run_token.__enter__()

    try:
        await stage_question_analysis(ctx)
        await stage_personas(ctx)
        await stage_outline(ctx)
        await stage_interviews(ctx)
        if settings.enable_verifier:
            await stage_verifier(ctx)
        await stage_synthesis(ctx)
        return await _finalize_run(ctx)
    except BudgetExceeded as be:
        await _handle_budget_exceeded(ctx, be)
        raise
    except Exception as e:
        logger.exception("Run %s failed", run_id)
        await ctx.bus.emit(
            SSEEvent(type="error", run_id=run_id, data={"message": str(e)})
        )
        raise
    finally:
        await _cleanup_run(ctx, run_token)


async def _finalize_run(ctx: StageContext) -> FinalReport:
    """Write run-summary + index after a successful pipeline.

    Emits ``final_ready`` and finalises the manifest. Returns the
    :class:`FinalReport` produced by :func:`stage_synthesis`.
    """
    if ctx.final is None:
        raise RuntimeError("_finalize_run called before stage_synthesis populated ctx.final")
    total_elapsed = round(time.monotonic() - ctx.t0, 1)
    ctx.writer.write_run_summary(
        question=ctx.question,
        elapsed_s=total_elapsed,
        n_personas=len(ctx.personas),
        n_subreports=len(ctx.sub_reports),
        n_citations=len(ctx.final.citations),
        verified=ctx.verified_count,
        flagged=ctx.flagged_count,
        n_reactions=0,
        stage_timings=ctx.stage_timings,
    )
    ctx.writer.write_index()
    logger.info(
        "run %s complete in %ss — %d citations (%d ✓, %d ⚠)",
        ctx.run_id, total_elapsed, len(ctx.final.citations),
        ctx.verified_count, ctx.flagged_count,
    )
    await ctx.bus.emit(
        SSEEvent(
            type="final_ready",
            run_id=ctx.run_id,
            data={
                "markdown_len": len(ctx.final.markdown),
                "n_citations": len(ctx.final.citations),
                "n_sections": len(ctx.final.outline),
                "elapsed_s": total_elapsed,
            },
        )
    )
    ctx.manifest.finalize()
    return ctx.final


async def _handle_budget_exceeded(ctx: StageContext, be: BudgetExceeded) -> None:
    """Write a partial brief from whatever stages completed.

    The cell still gets ``status="error"`` upstream, but the user gets a
    file with the personas that ran, the headlines from completed
    sub-reports, and a stage-by-stage spend breakdown so they can
    right-size ``max_cost_usd`` next time.
    """
    logger.warning(
        "Run %s halted by cost budget: projected $%.4f > limit $%.4f",
        ctx.run_id, be.spent, be.limit,
    )
    try:
        partial_md = render_partial_brief(
            question=ctx.question,
            personas=ctx.personas,
            sub_reports=ctx.sub_reports,
            seed_sections=ctx.seed_sections,
            spent=be.spent,
            limit=be.limit,
            cost_breakdown=ctx.cost_tracker.to_json(),
        )
        (ctx.run_dir / "final.md").write_text(partial_md, encoding="utf-8")
        (ctx.run_dir / "partial_brief.md").write_text(partial_md, encoding="utf-8")
        logger.info("Run %s wrote partial brief (%d bytes)", ctx.run_id, len(partial_md))
    except Exception:  # noqa: BLE001
        logger.exception("partial brief write failed for %s", ctx.run_id)
    await ctx.bus.emit(
        SSEEvent(
            type="error",
            run_id=ctx.run_id,
            data={
                "message": str(be),
                "reason": "budget_exceeded",
                "spent_usd": be.spent,
                "limit_usd": be.limit,
                "partial_brief": True,
                "n_subreports": len(ctx.sub_reports),
            },
        )
    )


async def _cleanup_run(ctx: StageContext, run_token: run_ctx) -> None:
    """Final cleanup that always runs (even on hard errors).

    Persists a cost summary to events.jsonl, drops the cost tracker from
    the registry, and closes the event bus.
    """
    ctx.manifest.finalize()
    try:
        await ctx.bus.emit(
            SSEEvent(
                type="cost_summary",
                run_id=ctx.run_id,
                data=ctx.cost_tracker.to_json(),
            )
        )
    except Exception:  # noqa: BLE001
        logger.debug("cost_summary emit failed", exc_info=True)
    try:
        run_token.__exit__(None, None, None)
    except Exception:  # noqa: BLE001
        pass
    drop_tracker(ctx.run_id)
    await ctx.bus.close()


# -------------------------------------------------- Dagster materialization


async def materialize_research_cell(
    question: str,
    run_id: str | None = None,
    n_personas: int | None = None,
    max_turns: int | None = None,
    *,
    enable_web_browse: bool | None = None,
    max_browses_per_cell: int | None = None,
    max_cost_usd: float | None = None,
    axes: dict[str, str] | None = None,
) -> FinalReport:
    """Execute one research cell through Dagster's asset graph.

    Runs the same pipeline as :func:`run_research` — same stage
    functions, same :class:`StageContext` — but the executor is Dagster.
    Each declared ``@asset`` in :mod:`dagster_assets` becomes one node
    in the run, with the cell ``run_id`` as the dynamic partition key.
    The asset bodies look up the live :class:`StageContext` from the
    process-local registry in :mod:`dagster_assets` and schedule the
    matching async stage on the parent event loop.

    The reason ``dagster.materialize`` runs in a worker thread: it's a
    sync function that wants its own event loop. Calling it from inside
    the parent FastAPI loop directly would error. ``asyncio.to_thread``
    keeps the parent loop responsive (so SSE consumers continue to
    drain the bus) while Dagster does its orchestration in the side
    thread.

    Returns the :class:`FinalReport` produced by ``stage_synthesis``,
    or raises :class:`BudgetExceeded` (with the partial brief already
    written) on budget exhaustion.

    ``axes`` is the multiverse axis-selection mapping for this cell (e.g.
    ``{"lens": "demand_space", "cohort": "sub60k"}``). It feeds into the
    content-addressed cell key emitted at end-of-cell so the Dagster
    instance recognises subsequent calls with the same axes as a re-run
    of the same intent. Single-shot research calls pass ``None`` and the
    key falls back to a hash of just the question.
    """
    from .dagster_assets import (
        ALL_ASSETS,
        cell_partitions,
        emit_cell_materialization,
        register_stage_context,
        unregister_stage_context,
    )

    run_id = run_id or new_run_id()
    settings = get_settings()
    parent_loop = asyncio.get_running_loop()
    t_cell_start = time.monotonic()
    ctx = build_stage_context(
        question=question,
        run_id=run_id,
        n_personas=n_personas,
        max_turns=max_turns,
        enable_web_browse=enable_web_browse,
        max_browses_per_cell=max_browses_per_cell,
        max_cost_usd=max_cost_usd,
        parent_loop=parent_loop,
    )

    ctx.axes = dict(axes) if axes else None
    # Resolve the Dagster instance once up-front so:
    #   (a) the worker thread that drives ``materialize()`` shares the
    #       same disk-backed event log as the parent loop;
    #   (b) the stage bodies can emit runless granular materializations
    #       (per-persona, per-turn, per-tool_call, per-citation, per-claim)
    #       against the same instance Dagit reads from.
    # Disposal happens in the outer ``finally`` so a stage emit landing
    # right before cleanup doesn't race a closed handle.
    dagster_instance = _resolve_dagster_instance()
    ctx.dagster_instance = dagster_instance
    register_stage_context(run_id, ctx)
    run_token = run_ctx(run_id)
    run_token.__enter__()

    # Note: contextvars set via run_token are bound to the parent loop's
    # task. The asset bodies run in a worker thread that does NOT inherit
    # those tokens. To keep cost attribution working from inside the
    # asset bodies, the asset adapters re-enter run_ctx(run_id) on the
    # parent loop when they schedule the stage coroutine.

    cell_status = "pending"
    cell_error: str | None = None
    try:
        result, _instance_back = await asyncio.to_thread(
            _run_dagster_materialize,
            run_id=run_id,
            partition_set_name=cell_partitions.name,
            assets=ALL_ASSETS,
            run_verifier=settings.enable_verifier,
            instance=dagster_instance,
        )
        try:
            if not result.success:
                # Surface the underlying failure cause if Dagster captured one.
                failure_msgs = [
                    str(ev.message) for ev in (result.all_events or [])
                    if "step_failure" in str(ev.event_type_value).lower()
                ]
                cell_status = "error"
                raise RuntimeError(
                    "Dagster materialization failed for cell "
                    f"{run_id!r}: {failure_msgs or 'no step_failure events captured'}"
                )
            final = await _finalize_run(ctx)
            cell_status = "complete"
            return final
        finally:
            # Emit the content-addressed cell materialization regardless
            # of stage outcome so even error cells get indexed in Dagit.
            # ``dagster_instance`` may be ephemeral when ``DAGSTER_HOME``
            # was not configurable; that's still useful for tests and
            # one-shot CLI runs even if Dagit can't see the event.
            if dagster_instance is not None:
                produced_paths: list[str] = []
                for fname in (
                    "final.md",
                    "final.json",
                    "manifest.json",
                    "cost.json",
                    "dagster_materializations.jsonl",
                ):
                    p = ctx.run_dir / fname
                    if p.exists():
                        produced_paths.append(str(p.relative_to(settings.runs_dir)))
                try:
                    emit_cell_materialization(
                        dagster_instance,
                        question=question,
                        axes=axes,
                        run_dir=ctx.run_dir,
                        status=cell_status,
                        wall_time_s=time.monotonic() - t_cell_start,
                        cost_tracker=ctx.cost_tracker,
                        produced_paths=produced_paths,
                        extras={
                            "run_id": run_id,
                            "error": cell_error,
                        },
                    )
                except Exception:  # noqa: BLE001
                    logger.exception(
                        "cell materialization emission failed for %s", run_id
                    )
                try:
                    dagster_instance.dispose()
                except Exception:  # noqa: BLE001
                    pass
    except BudgetExceeded as be:
        cell_status = "error"
        cell_error = str(be)
        await _handle_budget_exceeded(ctx, be)
        raise
    except Exception as e:
        # If Dagster wrapped a BudgetExceeded inside its own DagsterError,
        # unwrap and re-handle so the partial brief is written.
        budget_err = _find_budget_exceeded(e)
        if budget_err is not None:
            cell_status = "error"
            cell_error = str(budget_err)
            await _handle_budget_exceeded(ctx, budget_err)
            raise budget_err from e
        cell_status = "error"
        cell_error = str(e)
        logger.exception("Run %s failed", run_id)
        await ctx.bus.emit(
            SSEEvent(type="error", run_id=run_id, data={"message": str(e)})
        )
        raise
    finally:
        unregister_stage_context(run_id)
        await _cleanup_run(ctx, run_token)


def _resolve_dagster_instance() -> Any:
    """Resolve a Dagster instance, preferring the persistent disk-backed one.

    Order of preference:

    1. If ``DAGSTER_HOME`` is already set, load the configured instance
       via :meth:`DagsterInstance.from_config` so we read the SQLite stores
       declared in ``dagster.yaml`` instead of falling back to defaults.
    2. If a ``.dagster_home`` directory exists at the repo root, point
       ``DAGSTER_HOME`` at it for this process and load that instance.
       This is the FastAPI path: ``diageo dev`` only sets the env var
       for the Dagit child, so the API has to opt in itself for runs
       launched from ``/studies`` POSTs to show up in Dagit.
    3. Otherwise fall back to ``DagsterInstance.ephemeral()`` so unit
       tests stay hermetic.

    Returns the live :class:`DagsterInstance`.
    """
    import os
    import shutil

    from dagster import DagsterInstance

    repo_root = Path(__file__).resolve().parents[2]
    dagster_home = os.environ.get("DAGSTER_HOME")
    candidate = Path(dagster_home).resolve() if dagster_home else (repo_root / ".dagster_home").resolve()
    repo_yaml = repo_root / "dagster.yaml"

    if not dagster_home and not candidate.exists():
        logger.debug(
            "no DAGSTER_HOME and no .dagster_home; using ephemeral Dagster instance"
        )
        return DagsterInstance.ephemeral()

    candidate.mkdir(parents=True, exist_ok=True)
    # Mirror what `diageo dev` does for Dagit: drop dagster.yaml into the
    # home dir so SqliteRunStorage / EventLogStorage actually take
    # effect. Without this, dagster falls back to in-memory defaults
    # despite DAGSTER_HOME being set, and the API's runs never appear
    # in Dagit.
    target_yaml = candidate / "dagster.yaml"
    if not target_yaml.exists() and repo_yaml.exists():
        try:
            shutil.copyfile(repo_yaml, target_yaml)
        except OSError:
            logger.debug("dagster.yaml copy failed", exc_info=True)
    os.environ["DAGSTER_HOME"] = str(candidate)

    try:
        return DagsterInstance.from_config(str(candidate))
    except Exception:  # noqa: BLE001
        logger.exception(
            "DagsterInstance.from_config(%s) failed; falling back to ephemeral",
            candidate,
        )
        return DagsterInstance.ephemeral()


def _run_dagster_materialize(
    *,
    run_id: str,
    partition_set_name: str,
    assets: list[Any],
    run_verifier: bool,
    instance: Any | None = None,
) -> tuple[Any, Any]:
    """Synchronously execute one cell's assets through Dagster.

    Runs in a worker thread so Dagster gets a fresh event loop and the
    parent FastAPI loop stays responsive. The dynamic partition key is
    added to the resolved instance immediately before ``materialize``
    so the partition set is non-empty when Dagster looks it up.

    The ``assets`` argument is the full list. If verification is
    disabled in settings we skip the ``verifier`` asset by selecting
    everything else explicitly.

    ``instance`` lets the caller pass a pre-resolved
    :class:`DagsterInstance` so the parent loop's
    :class:`StageContext` and the worker-thread :func:`materialize`
    share the same disk-backed event log. Passing ``None`` falls back
    to a fresh :func:`_resolve_dagster_instance` for callers that
    don't need to share state (tests).

    Returns ``(result, instance)`` so the caller can:

    * Inspect ``result.success`` / events for the per-stage step status.
    * Use ``instance`` to emit the content-addressed cell materialization
      with :func:`dagster_assets.emit_cell_materialization` once the
      stage events have all landed.
    """
    from dagster import AssetSelection, materialize

    if instance is None:
        instance = _resolve_dagster_instance()
    try:
        instance.add_dynamic_partitions(partition_set_name, [run_id])
    except Exception:  # noqa: BLE001
        logger.debug("add_dynamic_partitions(%s, [%s]) failed", partition_set_name, run_id, exc_info=True)
    selection: AssetSelection | None = None
    if not run_verifier:
        selection = AssetSelection.all() - AssetSelection.keys("verifier")
    result = materialize(
        assets,
        partition_key=run_id,
        instance=instance,
        selection=selection,
        raise_on_error=False,
    )
    return result, instance


def _find_budget_exceeded(exc: BaseException) -> BudgetExceeded | None:
    """Walk the exception chain looking for a :class:`BudgetExceeded`.

    Dagster wraps op exceptions in ``DagsterUserCodeExecutionError`` /
    ``DagsterExecutionStepExecutionError`` and similar, with the original
    exception attached via ``__cause__`` or stored as an attribute. We
    walk both sides so we can still surface budget exhaustion as the
    semantic error type the rest of the system expects.
    """
    seen: set[int] = set()
    stack: list[BaseException] = [exc]
    while stack:
        cur = stack.pop()
        if id(cur) in seen:
            continue
        seen.add(id(cur))
        if isinstance(cur, BudgetExceeded):
            return cur
        # Dagster's DagsterUserCodeExecutionError stashes the original
        # exception on ``original_exc_info`` / ``user_exception``.
        for attr in ("user_exception", "original_exception"):
            inner = getattr(cur, attr, None)
            if isinstance(inner, BaseException):
                stack.append(inner)
        if cur.__cause__ is not None:
            stack.append(cur.__cause__)
        if cur.__context__ is not None:
            stack.append(cur.__context__)
    return None


__all__ = [
    "materialize_research_cell",
    "new_run_id",
    "run_research",
    "_resolve_dagster_instance",
]

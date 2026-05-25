"""Human-in-the-loop pause primitive.

The orchestrator pauses after generating the seed outline + analyst panel +
section assignments and BEFORE running any analyst interviews. While paused,
the FastAPI layer exposes:

- `GET  /research/{run_id}/plan` — read the current plan
- `POST /research/{run_id}/plan` — submit edits + resume / abort

This module owns the bridge between the two: the orchestrator awaits a
per-run `asyncio.Event` and reads back the (possibly edited) plan; the API
layer writes the edited plan and sets the event.

The HITL pause is opt-in (driven by the request flag `human_in_loop` on the
`POST /research` endpoint). CLI runs always skip the pause so existing
batch flows never block on a user that isn't there.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from .models import PlanEdit, PlanForReview

logger = logging.getLogger(__name__)


# How long we wait for a human edit before timing out the pause and
# aborting the run. 30 minutes is generous for a partner reviewing a panel
# but won't leak forever if the browser is closed.
DEFAULT_PAUSE_TIMEOUT_S: float = 30 * 60


@dataclass
class _PendingPlan:
    plan: PlanForReview
    event: asyncio.Event
    edit: PlanEdit | None = None


_pending: dict[str, _PendingPlan] = {}


def is_paused(run_id: str) -> bool:
    """Whether `run_id` is currently parked at the HITL pause."""
    return run_id in _pending


def get_plan(run_id: str) -> PlanForReview | None:
    """Return the current plan if the run is paused at HITL, else None."""
    pending = _pending.get(run_id)
    return pending.plan if pending is not None else None


def submit_edit(run_id: str, edit: PlanEdit) -> bool:
    """Hand the orchestrator the human edit (or approve/abort decision) and
    wake it up. Returns False if the run isn't currently paused."""
    pending = _pending.get(run_id)
    if pending is None:
        return False
    pending.edit = edit
    pending.event.set()
    logger.info(
        "hitl: run %s received decision=%s (personas_edit=%s sections_edit=%s)",
        run_id,
        edit.decision,
        edit.personas is not None,
        edit.sections is not None,
    )
    return True


async def await_edits(
    run_id: str,
    plan: PlanForReview,
    timeout_s: float = DEFAULT_PAUSE_TIMEOUT_S,
) -> PlanEdit:
    """Park the run until a human submits an edit (or the timeout elapses).

    Always returns a `PlanEdit`. If the timeout elapses without a decision,
    the returned edit is `decision="abort"` so the orchestrator can fail
    cleanly rather than running interviews on a stale plan.
    """
    event = asyncio.Event()
    pending = _PendingPlan(plan=plan, event=event)
    _pending[run_id] = pending
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout_s)
    except asyncio.TimeoutError:
        logger.warning(
            "hitl: run %s timed out after %.0fs without a human edit; aborting",
            run_id, timeout_s,
        )
        return PlanEdit(decision="abort")
    finally:
        _pending.pop(run_id, None)
    return pending.edit or PlanEdit(decision="approve")


def apply_edits(plan: PlanForReview, edit: PlanEdit) -> PlanForReview:
    """Return a new `PlanForReview` with the human edits applied. Empty
    fields on the edit fall back to the upstream plan values; non-empty
    fields override."""
    return plan.model_copy(
        update={
            "executive_intent": (
                edit.executive_intent
                if edit.executive_intent is not None
                else plan.executive_intent
            ),
            "personas": (
                edit.personas if edit.personas is not None else plan.personas
            ),
            "sections": (
                edit.sections if edit.sections is not None else plan.sections
            ),
        }
    )

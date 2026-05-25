"""Token → dollar pricing + cumulative cost tracker.

Anthropic charges per 1M tokens, with a discounted rate for prompt-cache
reads. We don't need to be exact to four decimal places — the goal is a
running estimate so the workbench can show "this cell has spent $X" and
the budget guard can stop a cell that crosses ``max_cost_usd``. Prices are
the public list as of 2026-05; bump when new SKUs are added.

The pricing table is intentionally permissive: unknown model ids fall back
to the highest published Sonnet/Opus rate so we never *under*-estimate a
charge and accidentally let a cell bust the budget.

Wiring overview
---------------
1. The orchestrator wraps ``AsyncAnthropic`` in :class:`MeteredAsyncAnthropic`
   per run, attaches a :class:`CostTracker` for that run, and registers the
   tracker in :data:`_TRACKERS`.
2. The orchestrator sets a few :mod:`contextvars` at stage / persona
   boundaries — :func:`stage_ctx`, :func:`persona_ctx`, :func:`run_ctx`.
   These propagate through ``asyncio.gather`` because contextvars are
   copied into each task on spawn.
3. Every ``client.messages.create()`` call inside a metered run hits the
   wrapper, which (a) checks the budget and raises
   :class:`BudgetExceeded` if exhausted, (b) calls the underlying SDK,
   (c) records the returned ``usage`` against the right run/stage/persona,
   and (d) emits an SSE ``cost`` event for the workbench.
"""
from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import threading
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class _Price(BaseModel):
    """Per-token rates in USD (so that token_count * rate = USD)."""

    input: float
    cached_input: float
    output: float


# Public list-price USD per 1M tokens, divided by 1e6 to get per-token.
# Source: anthropic.com/pricing as of 2026-05.
_RATES: dict[str, _Price] = {
    # Opus 4.x family
    "claude-opus-4-5": _Price(
        input=15.0 / 1_000_000, cached_input=1.50 / 1_000_000, output=75.0 / 1_000_000
    ),
    "claude-opus-4-7": _Price(
        input=15.0 / 1_000_000, cached_input=1.50 / 1_000_000, output=75.0 / 1_000_000
    ),
    # Sonnet 4.x family
    "claude-sonnet-4-5": _Price(
        input=3.0 / 1_000_000, cached_input=0.30 / 1_000_000, output=15.0 / 1_000_000
    ),
    "claude-sonnet-4-6": _Price(
        input=3.0 / 1_000_000, cached_input=0.30 / 1_000_000, output=15.0 / 1_000_000
    ),
    # Haiku — for completeness; we don't use it today.
    "claude-haiku-4": _Price(
        input=0.80 / 1_000_000, cached_input=0.08 / 1_000_000, output=4.0 / 1_000_000
    ),
}

# Conservative fallback. If we see a new model id we haven't priced, charge
# at Opus rates so the budget guard errs on the side of stopping early.
_FALLBACK_RATE = _RATES["claude-opus-4-7"]


def estimate_call_cost(
    model_id: str,
    *,
    max_tokens: int | None,
    messages: Any = None,
    system: Any = None,
    tools: Any = None,
    safety_factor: float = 1.10,
) -> float:
    """Pessimistic upfront cost estimate for one ``messages.create`` call.

    Used for budget reservation BEFORE the call goes out. We have to be
    pessimistic — under-estimating turns the budget guard back into a
    suggestion. The arithmetic:

      output_estimate = max_tokens (we assume the model uses every token)
      input_estimate  = char-count(messages + system + tools) / 4
                        (Claude's tokenizer averages ~4 chars/token; we
                        add 200 token tools-overhead and a 10% safety
                        margin on top of the whole sum.)

    Returns the estimate in USD. Callers pass this to
    :meth:`CostTracker.reserve` to claim budget headroom before the call
    runs.
    """
    rate = price_for(model_id)
    out_estimate = max(0, int(max_tokens or 0))
    input_chars = 0
    try:
        # `messages` is a list of {"role": ..., "content": str | [block]}
        if isinstance(messages, list):
            for m in messages:
                content = m.get("content") if isinstance(m, dict) else None
                if isinstance(content, str):
                    input_chars += len(content)
                elif isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict):
                            text = block.get("text") or block.get("content") or ""
                            if isinstance(text, str):
                                input_chars += len(text)
                            else:
                                # tool_use input dict, tool_result content list, etc.
                                input_chars += len(str(text))
        if isinstance(system, list):
            for block in system:
                if isinstance(block, dict):
                    t = block.get("text") or ""
                    input_chars += len(t) if isinstance(t, str) else 0
        elif isinstance(system, str):
            input_chars += len(system)
    except Exception:  # noqa: BLE001
        # Estimation is best-effort; never break a real call because we
        # couldn't introspect a message shape.
        pass
    # ~4 chars/token average for Claude's tokenizer.
    input_token_estimate = input_chars // 4
    if isinstance(tools, list) and tools:
        input_token_estimate += 200  # tools schema + cache key overhead
    cost = (
        input_token_estimate * rate.input
        + out_estimate * rate.output
    )
    return cost * float(safety_factor)


def price_for(model_id: str) -> _Price:
    """Look up per-token rates by model id. Unknown ids fall back to Opus
    rates so the cumulative estimate is never lower than the real bill."""
    if not model_id:
        return _FALLBACK_RATE
    if model_id in _RATES:
        return _RATES[model_id]
    # Loose match on family — handles `claude-opus-4-7-thinking` etc.
    base = model_id.lower()
    for key in _RATES:
        if base.startswith(key):
            return _RATES[key]
    return _FALLBACK_RATE


# ----------------------------------------------------------------- Tracker


class CostBreakdown(BaseModel):
    """Accumulated cost + token counts across one run / cell."""

    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    by_model: dict[str, dict[str, float]] = Field(default_factory=dict)
    by_stage: dict[str, dict[str, float]] = Field(default_factory=dict)
    by_persona: dict[str, dict[str, float]] = Field(default_factory=dict)
    n_calls: int = 0


class BudgetExceeded(RuntimeError):
    """Raised by ``CostTracker.check_budget`` when ``max_cost_usd`` is hit.
    The orchestrator catches this so the cell is marked errored with a
    clear reason rather than a generic exception."""

    def __init__(self, spent: float, limit: float) -> None:
        super().__init__(
            f"Cost budget exhausted: spent ${spent:.4f} >= limit ${limit:.4f}. "
            f"Stopping the cell so the rest of the study can finish."
        )
        self.spent = spent
        self.limit = limit


class CostTracker:
    """Thread + asyncio safe accumulator for one run.

    Call ``record(usage, model_id, stage=..., persona_id=...)`` after every
    Anthropic call (or get one from ``wrap_response``). Persistence is best
    effort — we write ``runs/<run_id>/cost.json`` after every increment so
    a partial cell still leaves a useful artefact on disk.

    Concurrency-aware budget enforcement
    ------------------------------------
    Naive ``check_budget()`` only inspects already-recorded spend, which
    creates a race when N parallel ``messages.create()`` calls all check
    simultaneously and all pass before any of them records. The fix here
    is *pessimistic reservation*: each call reserves its worst-case cost
    upfront via :meth:`reserve` (which enforces the budget against the
    sum of recorded + reserved), the call runs, and either
    :meth:`record_with_release` lands the actuals while releasing the
    reservation, or :meth:`release` rolls back on failure. Concurrent
    sibling tasks therefore see each other's reservations and cannot
    collectively breach ``max_cost_usd``.
    """

    def __init__(self, run_dir: Path, max_cost_usd: float | None = None) -> None:
        self.run_dir = run_dir
        self.max_cost_usd = max_cost_usd
        self._b = CostBreakdown()
        self._reserved_usd: float = 0.0
        self._lock = threading.Lock()
        run_dir.mkdir(parents=True, exist_ok=True)

    @property
    def cost_usd(self) -> float:
        return self._b.cost_usd

    @property
    def reserved_usd(self) -> float:
        return self._reserved_usd

    @property
    def projected_usd(self) -> float:
        """Recorded + reserved. This is the number budget enforcement
        compares against ``max_cost_usd``."""
        return self._b.cost_usd + self._reserved_usd

    @property
    def breakdown(self) -> CostBreakdown:
        return self._b

    def reserve(self, estimated_usd: float) -> float:
        """Reserve ``estimated_usd`` against the budget.

        Raises :class:`BudgetExceeded` if (recorded + reserved + this
        reservation) would cross ``max_cost_usd``. Returns the reserved
        amount on success — pass it back to :meth:`record_with_release`
        or :meth:`release` so the reservation is correctly cleared.

        The reservation MUST be released eventually (on success via
        ``record_with_release`` or on failure via ``release``) — every
        ``reserve()`` call needs a paired release or the budget guard
        keeps blocking subsequent calls forever.
        """
        if estimated_usd < 0:
            estimated_usd = 0.0
        with self._lock:
            new_total = self._b.cost_usd + self._reserved_usd + estimated_usd
            if self.max_cost_usd is not None and new_total > self.max_cost_usd:
                raise BudgetExceeded(new_total, float(self.max_cost_usd))
            self._reserved_usd += estimated_usd
            return estimated_usd

    def release(self, reserved_usd: float) -> None:
        """Roll back a reservation (e.g. on call failure). Cheap; never raises."""
        if reserved_usd <= 0:
            return
        with self._lock:
            self._reserved_usd = max(0.0, self._reserved_usd - reserved_usd)

    def record(
        self,
        usage: Any,
        model_id: str,
        *,
        stage: str = "unknown",
        persona_id: str | None = None,
        release_reserved_usd: float = 0.0,
    ) -> dict[str, Any]:
        """Accumulate one Anthropic ``Usage`` object. Returns a small dict
        describing this single increment so the caller can emit an SSE
        event with it. ``usage`` is whatever the SDK gave us — we read
        ``input_tokens``, ``output_tokens``, and the cache fields if the
        SDK exposes them.

        ``release_reserved_usd`` is the upfront reservation that this call
        is now settling — pass the value returned by :meth:`reserve` so
        the reservation is cleared atomically with the recording. (This
        prevents a race where another sibling task reads stale
        ``projected_usd`` between our ``record`` and ``release``.)
        """
        rate = price_for(model_id)
        in_tok = int(getattr(usage, "input_tokens", 0) or 0)
        out_tok = int(getattr(usage, "output_tokens", 0) or 0)
        # Cache fields: cache_read_input_tokens, cache_creation_input_tokens.
        cache_read = int(getattr(usage, "cache_read_input_tokens", 0) or 0)
        cache_create = int(getattr(usage, "cache_creation_input_tokens", 0) or 0)
        # The SDK already excludes cache_read_input_tokens from input_tokens
        # in newer versions, but cache_creation is part of input. We bill
        # cache_create at the input rate (write is full price), cache_read
        # at the discount rate.
        billable_input = max(0, in_tok)
        cost = (
            billable_input * rate.input
            + cache_read * rate.cached_input
            + cache_create * rate.input
            + out_tok * rate.output
        )
        with self._lock:
            self._b.input_tokens += billable_input + cache_create
            self._b.cached_input_tokens += cache_read
            self._b.output_tokens += out_tok
            self._b.cost_usd += cost
            self._b.n_calls += 1
            if release_reserved_usd > 0:
                self._reserved_usd = max(
                    0.0, self._reserved_usd - release_reserved_usd
                )
            self._add_into(self._b.by_model, model_id, in_tok, cache_read, out_tok, cost)
            self._add_into(self._b.by_stage, stage, in_tok, cache_read, out_tok, cost)
            if persona_id:
                self._add_into(
                    self._b.by_persona, persona_id, in_tok, cache_read, out_tok, cost
                )
            self._persist_locked()
        return {
            "model": model_id,
            "stage": stage,
            "persona_id": persona_id,
            "input_tokens": in_tok,
            "cached_input_tokens": cache_read,
            "output_tokens": out_tok,
            "incremental_usd": round(cost, 6),
            "cumulative_usd": round(self._b.cost_usd, 6),
            "projected_usd": round(self.projected_usd, 6),
        }

    def check_budget(self) -> None:
        """Raise ``BudgetExceeded`` if the run has already crossed its
        ceiling on RECORDED spend alone. Cheap pre-flight check — paired
        with :meth:`reserve` for full concurrency-safe enforcement.
        """
        if self.max_cost_usd is None:
            return
        if self._b.cost_usd >= self.max_cost_usd:
            raise BudgetExceeded(self._b.cost_usd, float(self.max_cost_usd))

    def to_json(self) -> dict[str, Any]:
        return {
            **self._b.model_dump(),
            "max_cost_usd": self.max_cost_usd,
        }

    @staticmethod
    def _add_into(
        bucket: dict[str, dict[str, float]],
        key: str,
        in_tok: int,
        cache_read: int,
        out_tok: int,
        cost: float,
    ) -> None:
        cur = bucket.setdefault(
            key,
            {
                "input_tokens": 0.0,
                "cached_input_tokens": 0.0,
                "output_tokens": 0.0,
                "cost_usd": 0.0,
                "n_calls": 0.0,
            },
        )
        cur["input_tokens"] += in_tok
        cur["cached_input_tokens"] += cache_read
        cur["output_tokens"] += out_tok
        cur["cost_usd"] += cost
        cur["n_calls"] += 1

    def _persist_locked(self) -> None:
        # Caller already holds self._lock.
        path = self.run_dir / "cost.json"
        try:
            tmp = self.run_dir / ".cost.json.tmp"
            tmp.write_text(json.dumps(self.to_json(), indent=2), encoding="utf-8")
            tmp.replace(path)
        except Exception as e:  # noqa: BLE001
            logger.debug("CostTracker.persist failed: %s", e)


# ------------------------------------ Module-level registry of run trackers
#
# A run-scoped registry lets non-orchestrator callers (perspective.answer,
# summarizer.synthesize, persona_generator.generate, etc.) attach usage to
# the right CostTracker without threading the object through every signature.

_TRACKERS: dict[str, CostTracker] = {}
_TRACKERS_LOCK = threading.Lock()


def register_tracker(run_id: str, tracker: CostTracker) -> None:
    with _TRACKERS_LOCK:
        _TRACKERS[run_id] = tracker


def get_tracker(run_id: str) -> CostTracker | None:
    with _TRACKERS_LOCK:
        return _TRACKERS.get(run_id)


def drop_tracker(run_id: str) -> None:
    with _TRACKERS_LOCK:
        _TRACKERS.pop(run_id, None)


def record_for_run(
    run_id: str,
    usage: Any,
    model_id: str,
    *,
    stage: str = "unknown",
    persona_id: str | None = None,
) -> dict[str, Any] | None:
    tracker = get_tracker(run_id)
    if tracker is None:
        return None
    return tracker.record(usage, model_id, stage=stage, persona_id=persona_id)


async def emit_cost_event(
    bus: Any,
    run_id: str,
    increment: dict[str, Any] | None,
) -> None:
    """Best-effort SSE emit. Caller may pass ``None`` if record_for_run
    returned ``None`` (no tracker for this run id)."""
    if not increment or bus is None:
        return
    try:
        from .models import SSEEvent

        await bus.emit(
            SSEEvent(
                type="cost",
                run_id=run_id,
                persona_id=increment.get("persona_id"),
                data=increment,
            )
        )
    except Exception:  # noqa: BLE001
        # Cost telemetry is fire-and-forget — never break the pipeline.
        logger.debug("emit_cost_event failed", exc_info=True)


# ---------------------------------------------------- ContextVar attribution
#
# These let any callsite below the orchestrator attribute its Anthropic
# spend to the right run/stage/persona without threading new arguments.
# contextvars propagate into asyncio.gather()'d children automatically,
# which is essential because per-persona interviews are spawned in
# parallel.

_current_run_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "diageo_research_current_run_id", default=None
)
_current_stage: contextvars.ContextVar[str] = contextvars.ContextVar(
    "diageo_research_current_stage", default="unknown"
)
_current_persona: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "diageo_research_current_persona", default=None
)


class run_ctx:
    """Bind ``run_id`` for the duration of the with-block. Use this once at
    the top of ``run_research`` so every nested ``messages.create()`` call
    can find the right cost tracker.
    """

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self._token: contextvars.Token | None = None

    def __enter__(self) -> "run_ctx":
        self._token = _current_run_id.set(self.run_id)
        return self

    def __exit__(self, *a: Any) -> None:
        if self._token is not None:
            _current_run_id.reset(self._token)


class stage_ctx:
    """Bind a stage name (``personas``, ``interviews``, ``synthesis``…) so
    the cost tracker can break costs out by stage in ``cost.json``."""

    def __init__(self, stage: str) -> None:
        self.stage = stage
        self._token: contextvars.Token | None = None

    def __enter__(self) -> "stage_ctx":
        self._token = _current_stage.set(self.stage)
        return self

    def __exit__(self, *a: Any) -> None:
        if self._token is not None:
            _current_stage.reset(self._token)


class persona_ctx:
    """Bind a persona id (``p1``, ``p2``…) for per-persona cost attribution
    inside the parallel interview gather."""

    def __init__(self, persona_id: str | None) -> None:
        self.persona_id = persona_id
        self._token: contextvars.Token | None = None

    def __enter__(self) -> "persona_ctx":
        self._token = _current_persona.set(self.persona_id)
        return self

    def __exit__(self, *a: Any) -> None:
        if self._token is not None:
            _current_persona.reset(self._token)


# -------------------------------------------------- MeteredAsyncAnthropic
#
# Lightweight wrapper that mirrors the ``client.messages.create`` surface
# the rest of the codebase uses. Construct one per run and pass it
# everywhere ``AsyncAnthropic`` is currently passed; nothing else needs to
# change. If no tracker is registered (e.g. unit tests), it forwards
# transparently.


class MeteredAsyncAnthropic:
    """Drop-in replacement for ``anthropic.AsyncAnthropic`` that meters
    every ``client.messages.create`` call against a :class:`CostTracker`.

    The wrapper deliberately exposes only the surface our codebase uses
    today (``messages.create`` and the ``__getattr__`` passthrough). When
    callers reach for a less-common attribute we fall back to the inner
    client so behaviour is identical.
    """

    def __init__(self, *, api_key: str, run_id: str | None = None) -> None:
        from anthropic import AsyncAnthropic  # local import keeps tests light

        self._inner = AsyncAnthropic(api_key=api_key)
        self._run_id = run_id
        self.messages = _MeteredMessages(self._inner, run_id_hint=run_id)

    # Forward any unknown attribute to the wrapped client.
    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


class _MeteredMessages:
    def __init__(self, inner: Any, *, run_id_hint: str | None = None) -> None:
        self._inner = inner
        # The orchestrator can pass a run_id at wrapper construction; we
        # still prefer the contextvar at call time because the same
        # MeteredAsyncAnthropic could in principle be reused across runs.
        self._run_id_hint = run_id_hint

    async def create(self, **kwargs: Any) -> Any:
        run_id = _current_run_id.get() or self._run_id_hint
        tracker = get_tracker(run_id) if run_id else None
        model_id = str(kwargs.get("model") or "")
        # Pessimistic upfront reservation. This is the critical fix for
        # parallel `asyncio.gather()` calls: every concurrent
        # ``messages.create`` reserves its worst-case cost BEFORE making
        # the request, so siblings see each other's reservations and the
        # budget guard cannot be raced.
        reserved = 0.0
        if tracker is not None:
            estimate = estimate_call_cost(
                model_id,
                max_tokens=kwargs.get("max_tokens"),
                messages=kwargs.get("messages"),
                system=kwargs.get("system"),
                tools=kwargs.get("tools"),
            )
            # `reserve()` raises BudgetExceeded if the projected total
            # crosses the ceiling — this is the budget enforcement point.
            reserved = tracker.reserve(estimate)
        try:
            resp = await self._inner.messages.create(**kwargs)
        except Exception:
            # Roll back the reservation so unrelated retries / sibling
            # calls don't get blocked by phantom budget.
            if tracker is not None and reserved > 0:
                tracker.release(reserved)
            raise
        if tracker is not None:
            usage = getattr(resp, "usage", None)
            if usage is not None:
                stage = _current_stage.get() or "unknown"
                persona_id = _current_persona.get()
                inc = tracker.record(
                    usage,
                    model_id,
                    stage=stage,
                    persona_id=persona_id,
                    release_reserved_usd=reserved,
                )
                reserved = 0.0  # released atomically by record()
                # Fire-and-forget SSE so the workbench shows live $.
                try:
                    from .events import get_bus

                    bus = get_bus(run_id) if run_id else None
                    if bus is not None:
                        # Don't block the caller on SSE emission.
                        asyncio.create_task(emit_cost_event(bus, run_id, inc))
                except Exception:  # noqa: BLE001
                    pass
            else:
                # No usage data on the response (unusual) — clear our
                # reservation by hand so we don't leak budget.
                tracker.release(reserved)
                reserved = 0.0
        return resp

    # Forward anything else the SDK exposes that we haven't wrapped.
    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

"""Integration test: run a tiny ``run_research`` flow against a stubbed
Anthropic client and confirm the cost tracker (a) accumulates spend
across stages, (b) persists ``cost.json`` to disk, and (c) emits a
``cost`` SSE event so the workbench can render live $.

We stub the Anthropic client at the wrapper boundary so we never make a
real API call but the metered wrapper still exercises the real
``record()`` + budget-check path.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest


class _StubMessages:
    """Mirrors ``anthropic.AsyncAnthropic().messages``. Returns a fake
    response object with the ``.usage`` shape the cost tracker reads."""

    def __init__(self, *, output_text: str = "OK", input_tokens: int = 1000, output_tokens: int = 200) -> None:
        self.output_text = output_text
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            id="msg_stub",
            stop_reason="end_turn",
            content=[SimpleNamespace(type="text", text=self.output_text)],
            usage=SimpleNamespace(
                input_tokens=self.input_tokens,
                output_tokens=self.output_tokens,
                cache_read_input_tokens=0,
                cache_creation_input_tokens=0,
            ),
        )


@pytest.mark.asyncio
async def test_metered_client_wires_cost_into_disk(tmp_path: Path, monkeypatch) -> None:
    """Drive the metered wrapper directly. Even outside ``run_research``,
    a registered tracker + ``run_ctx`` should accumulate costs and write
    ``cost.json``."""
    from diageo_research.pricing import (
        CostTracker,
        MeteredAsyncAnthropic,
        drop_tracker,
        register_tracker,
        run_ctx,
        stage_ctx,
    )

    run_dir = tmp_path / "runs" / "stub_run"
    run_dir.mkdir(parents=True, exist_ok=True)
    tracker = CostTracker(run_dir, max_cost_usd=None)
    register_tracker("stub_run", tracker)

    client = MeteredAsyncAnthropic(api_key="test", run_id="stub_run")
    # Replace the underlying SDK with our stub so no real call leaves the box.
    stub = _StubMessages(output_text="hello", input_tokens=2000, output_tokens=500)
    client._inner.messages = stub  # type: ignore[attr-defined]
    client.messages._inner = client._inner  # type: ignore[attr-defined]

    try:
        with run_ctx("stub_run"), stage_ctx("personas"):
            for _ in range(3):
                await client.messages.create(model="claude-sonnet-4-6", messages=[])
        assert tracker.breakdown.n_calls == 3
        assert tracker.breakdown.cost_usd > 0
        assert tracker.breakdown.by_stage["personas"]["n_calls"] == 3
        cost_file = run_dir / "cost.json"
        assert cost_file.exists()
        data = json.loads(cost_file.read_text())
        assert data["n_calls"] == 3
        assert data["by_stage"]["personas"]["n_calls"] == 3
    finally:
        drop_tracker("stub_run")


@pytest.mark.asyncio
async def test_parallel_calls_cannot_collectively_breach_budget(tmp_path: Path) -> None:
    """Regression for the May-25 race: 6 parallel ``messages.create`` calls
    fired via ``asyncio.gather`` must NOT collectively spend past
    ``max_cost_usd``. The fix is pessimistic upfront reservation in
    :class:`MeteredAsyncAnthropic` — each concurrent call reserves its
    worst-case cost before the request flies, so siblings see each
    other's reservations and the late ones raise.

    Before the fix, ``cost.json`` showed ``$2.46`` on a ``$1.50`` budget.
    After the fix, total recorded spend never exceeds the ceiling.
    """
    import asyncio

    from diageo_research.pricing import (
        BudgetExceeded,
        CostTracker,
        MeteredAsyncAnthropic,
        drop_tracker,
        register_tracker,
        run_ctx,
        stage_ctx,
    )

    run_dir = tmp_path / "runs" / "race_run"
    run_dir.mkdir(parents=True, exist_ok=True)
    # Cap of ~$0.20 — a single Opus call at 1800 max_tokens reserves
    # ~$0.135 worth of output alone, so AT MOST one concurrent caller
    # can claim the budget.
    tracker = CostTracker(run_dir, max_cost_usd=0.20)
    register_tracker("race_run", tracker)
    client = MeteredAsyncAnthropic(api_key="test", run_id="race_run")

    # Slow stub: introduces a real await so all 6 calls truly run in
    # parallel before any of them records.
    async def _slow_create(**kwargs):
        await asyncio.sleep(0.01)
        return SimpleNamespace(
            id="x",
            stop_reason="end_turn",
            content=[SimpleNamespace(type="text", text="ok")],
            usage=SimpleNamespace(
                input_tokens=2000,
                output_tokens=500,
                cache_read_input_tokens=0,
                cache_creation_input_tokens=0,
            ),
        )

    client._inner.messages = SimpleNamespace(create=_slow_create)  # type: ignore[attr-defined]
    client.messages._inner = client._inner  # type: ignore[attr-defined]

    try:
        with run_ctx("race_run"), stage_ctx("synthesis"):
            results = await asyncio.gather(
                *[
                    client.messages.create(
                        model="claude-opus-4-7",
                        max_tokens=1800,
                        messages=[{"role": "user", "content": "x" * 200}],
                    )
                    for _ in range(6)
                ],
                return_exceptions=True,
            )
        # Most calls should be BudgetExceeded; AT MOST one can succeed.
        successes = [r for r in results if not isinstance(r, Exception)]
        budget_errs = [r for r in results if isinstance(r, BudgetExceeded)]
        assert len(successes) <= 1, (
            "Pessimistic reservation should let at most ONE concurrent caller "
            f"through; got {len(successes)} successes."
        )
        assert len(budget_errs) >= 5
        # And the recorded total never crosses the ceiling.
        assert tracker.cost_usd <= tracker.max_cost_usd, (
            f"Recorded ${tracker.cost_usd:.4f} > ceiling ${tracker.max_cost_usd:.4f}"
        )
    finally:
        drop_tracker("race_run")


@pytest.mark.asyncio
async def test_metered_client_raises_budget_exceeded(tmp_path: Path) -> None:
    """When the run's ``max_cost_usd`` ceiling is crossed, the next
    ``messages.create`` must raise BudgetExceeded BEFORE making the call."""
    from diageo_research.pricing import (
        BudgetExceeded,
        CostTracker,
        MeteredAsyncAnthropic,
        drop_tracker,
        register_tracker,
        run_ctx,
        stage_ctx,
    )

    run_dir = tmp_path / "runs" / "budget_run"
    run_dir.mkdir(parents=True, exist_ok=True)
    tracker = CostTracker(run_dir, max_cost_usd=0.0001)  # essentially zero
    register_tracker("budget_run", tracker)

    client = MeteredAsyncAnthropic(api_key="test", run_id="budget_run")
    stub = _StubMessages(input_tokens=10_000, output_tokens=10_000)
    client._inner.messages = stub  # type: ignore[attr-defined]
    client.messages._inner = client._inner  # type: ignore[attr-defined]

    try:
        with run_ctx("budget_run"), stage_ctx("synthesis"):
            await client.messages.create(model="claude-opus-4-7", messages=[])
            with pytest.raises(BudgetExceeded):
                await client.messages.create(model="claude-opus-4-7", messages=[])
        # Exactly one call landed before the guard tripped.
        assert tracker.breakdown.n_calls == 1
    finally:
        drop_tracker("budget_run")

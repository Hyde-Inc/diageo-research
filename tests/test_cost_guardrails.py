"""Cost-guardrail unit tests.

These confirm three behaviours that protect against runaway Anthropic spend:

1. ``ToolRegistry`` short-circuits ``web_browse`` when ``enable_web_browse``
   is False — and never spawns the browser-use Agent (so no Sonnet calls,
   no CAPTCHAs, no Chromium).
2. ``ToolRegistry`` honours ``max_browses_per_cell`` across persona turns
   (the previous cap was per-turn only — a cell with N turns could hit it
   N times).
3. ``CostTracker`` accumulates spend, persists ``cost.json``, and raises
   :class:`pricing.BudgetExceeded` once the dollar ceiling trips.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from diageo_research.pricing import (
    BudgetExceeded,
    CostTracker,
    drop_tracker,
    get_tracker,
    persona_ctx,
    price_for,
    register_tracker,
    run_ctx,
    stage_ctx,
)
from diageo_research.tools.registry import ToolRegistry


@pytest.mark.asyncio
async def test_browse_disabled_returns_hint_and_does_not_spawn(monkeypatch) -> None:
    """When ``enable_web_browse=False`` the dispatcher must short-circuit
    BEFORE the underlying ``browse()`` is ever called. A misconfigured
    cell would otherwise burn a Sonnet round-trip just to discover it
    can't reach Google."""
    spawned = {"called": False}

    async def _fake_browse(*args, **kwargs):
        spawned["called"] = True
        return [{"url": "x", "title": "x", "text": "x"}]

    monkeypatch.setattr("diageo_research.tools.registry.browse", _fake_browse)

    reg = ToolRegistry(enable_web_browse=False)
    out = await reg.dispatch("web_browse", {"query": "anything", "max_pages": 3})

    assert spawned["called"] is False, "browse() must NOT be called when disabled"
    assert out["snippets"] == []
    assert "disabled" in (out.get("hint") or "")
    # Tool log records the disabled outcome so the workbench can show it.
    assert reg.tool_call_log[0]["outcome"] == "disabled"


@pytest.mark.asyncio
async def test_browse_per_cell_cap_blocks_after_n_calls(monkeypatch) -> None:
    """The cell-level cap must persist across ``start_turn()`` boundaries
    (the per-turn cap only resets within a turn)."""
    counter = {"calls": 0}

    async def _fake_browse(*args, **kwargs):
        counter["calls"] += 1
        return [{"url": f"u{counter['calls']}", "title": "t", "text": "snip"}]

    monkeypatch.setattr("diageo_research.tools.registry.browse", _fake_browse)

    reg = ToolRegistry(enable_web_browse=True, max_browses_per_cell=2)

    # Three turns, one browse each. The first two succeed, the third hits
    # the cell cap and never reaches the underlying browser.
    for _ in range(3):
        reg.start_turn()
        await reg.dispatch("web_browse", {"query": "q", "max_pages": 1})

    assert counter["calls"] == 2, "per-cell browse cap should block the third call"
    outcomes = [c["outcome"] for c in reg.tool_call_log]
    assert outcomes == ["ok", "ok", "cell_cap"]


def test_price_for_unknown_falls_back_to_opus_rates() -> None:
    """Unknown model ids must NOT silently get a cheap price — the budget
    guard must err on the side of charging more so we stop early."""
    rate = price_for("claude-totally-fictional-9000")
    opus = price_for("claude-opus-4-7")
    assert rate.input == opus.input
    assert rate.output == opus.output


def test_cost_tracker_accumulates_and_persists(tmp_path: Path) -> None:
    """Each ``record()`` must update cumulative spend and write
    ``cost.json`` with the latest snapshot."""
    tracker = CostTracker(tmp_path, max_cost_usd=None)
    fake_usage = SimpleNamespace(
        input_tokens=1_000,
        output_tokens=500,
        cache_read_input_tokens=200,
        cache_creation_input_tokens=0,
    )
    inc = tracker.record(fake_usage, "claude-sonnet-4-6", stage="personas", persona_id="p1")
    assert inc["incremental_usd"] > 0
    assert tracker.breakdown.cost_usd > 0
    assert (tmp_path / "cost.json").exists()
    on_disk = json.loads((tmp_path / "cost.json").read_text())
    assert on_disk["n_calls"] == 1
    assert on_disk["by_stage"]["personas"]["n_calls"] == 1
    assert on_disk["by_persona"]["p1"]["n_calls"] == 1


def test_reserve_blocks_when_projected_total_would_exceed_budget(tmp_path: Path) -> None:
    """The reservation arithmetic is the fix for the parallel-burst race
    that produced ``cost_usd=$2.46`` on a ``$1.50`` budget. Once
    cumulative+reserved would cross the ceiling, the next ``reserve()``
    must raise — even though no actual ``record()`` has landed yet.
    """
    tracker = CostTracker(tmp_path, max_cost_usd=1.0)
    a = tracker.reserve(0.40)
    b = tracker.reserve(0.40)
    assert tracker.projected_usd == pytest.approx(0.80)
    # Third reservation would push us to $1.20 > $1.00 — must raise.
    with pytest.raises(BudgetExceeded):
        tracker.reserve(0.40)
    # Releasing one frees the headroom and the reservation succeeds.
    tracker.release(a)
    third = tracker.reserve(0.40)
    assert third == 0.40
    # Recording the second reservation as actuals must release it.
    fake_usage = SimpleNamespace(
        input_tokens=1000, output_tokens=500,
        cache_read_input_tokens=0, cache_creation_input_tokens=0,
    )
    inc = tracker.record(
        fake_usage, "claude-sonnet-4-6",
        stage="synthesis", release_reserved_usd=b,
    )
    # After release+record, only the third reservation remains.
    assert tracker.reserved_usd == pytest.approx(0.40)
    assert tracker.cost_usd > 0
    assert "projected_usd" in inc


def test_cost_tracker_budget_raises_when_crossed(tmp_path: Path) -> None:
    """The budget guard must raise BudgetExceeded the moment cumulative
    spend hits the ceiling — so the orchestrator can mark the cell errored
    *before* the next paid call goes out."""
    # Set ceiling well below what one Opus call costs.
    tracker = CostTracker(tmp_path, max_cost_usd=0.0001)
    fake_usage = SimpleNamespace(
        input_tokens=10_000,
        output_tokens=10_000,
        cache_read_input_tokens=0,
        cache_creation_input_tokens=0,
    )
    tracker.record(fake_usage, "claude-opus-4-7", stage="synthesis")
    with pytest.raises(BudgetExceeded) as ei:
        tracker.check_budget()
    assert ei.value.spent > ei.value.limit


def test_run_ctx_propagates_to_tracker(tmp_path: Path) -> None:
    """``run_ctx`` + the tracker registry are the wiring that lets the
    metered client attribute calls without threading the run id down
    through every function signature."""
    tracker = CostTracker(tmp_path)
    register_tracker("run-x", tracker)
    try:
        with run_ctx("run-x"), stage_ctx("personas"), persona_ctx("p1"):
            assert get_tracker("run-x") is tracker
    finally:
        drop_tracker("run-x")
    assert get_tracker("run-x") is None

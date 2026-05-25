"""Tests for the demo-eve harness fixes (perspective + browser tool budget).

Covers three regressions surfaced by the diagnostic subagent on the night
before the IEX demo:

1. Sonnet was emitting `web_browse` tool_use blocks even when the
   dispatcher had it disabled / cell-capped — the tool spec was still
   reaching the Anthropic API. The fix filters the spec list by
   operational state so the model literally cannot call a disabled
   tool.

2. `web_fetch` had no per-URL failure memory and no per-turn cap. A
   single bad URL (SSL error / 404 / empty body) was retried on every
   iteration, burning the entire `MAX_TOOL_ITERATIONS=6` budget on the
   same dead host. The fix records failure reasons in a per-cell cache
   and short-circuits verbatim retries without a network call.

3. The perspective loop ran the full 6 iterations even when every
   tool_result came back empty. The fix tracks consecutive unproductive
   iterations and bails to a "dead tools, answer from training data"
   synthesis path after `Settings.max_unproductive_tool_iters`
   (default 2) in a row.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from diageo_research.memory import DialogueMemory
from diageo_research.models import Persona
from diageo_research.perspective import (
    DEAD_TOOLS_SYNTHESIS_PROMPT,
    PerspectiveAgent,
)
from diageo_research.tools import web_fetch as web_fetch_mod
from diageo_research.tools.registry import ToolRegistry


# ---------------------------------------------------------------------------
# Fix 1: disabled / cap-exhausted browse must be filtered from the tool spec.
# ---------------------------------------------------------------------------


def test_disabled_browse_is_filtered_from_anthropic_specs() -> None:
    """The tool spec list passed to the Anthropic API must respect the
    `enable_web_browse` kill switch AND the `max_browses_per_cell` cap.
    Otherwise Sonnet can emit `web_browse` tool_use blocks that the
    dispatcher then short-circuits — wasting a paid round-trip per
    iteration."""
    # Default expert registry: browse enabled, well under any cap.
    reg = ToolRegistry(persona_type="expert", enable_web_browse=True)
    names = {s["name"] for s in reg.specs}
    assert "web_browse" in names, "browse spec should be present when enabled"

    # Disabled via kill switch.
    reg_off = ToolRegistry(persona_type="expert", enable_web_browse=False)
    names_off = {s["name"] for s in reg_off.specs}
    assert "web_browse" not in names_off
    # The other tools must survive the filter — we're composing, not replacing.
    assert {"web_fetch", "duckdb_query"}.issubset(names_off)

    # Cap exhausted: enable=True but total calls == cap.
    reg_cap = ToolRegistry(
        persona_type="expert", enable_web_browse=True, max_browses_per_cell=3
    )
    assert "web_browse" in {s["name"] for s in reg_cap.specs}
    reg_cap._browse_calls_total = 3  # simulate cell exhaustion
    names_cap = {s["name"] for s in reg_cap.specs}
    assert "web_browse" not in names_cap
    assert {"web_fetch", "duckdb_query"}.issubset(names_cap)


# ---------------------------------------------------------------------------
# Fix 2: per-URL failure cache + per-turn fetch cap.
# ---------------------------------------------------------------------------


def _stub_client_factory(behaviour, n_calls: dict[str, int]):
    """Build an httpx.AsyncClient stub whose `.get(url)` runs `behaviour`.

    `behaviour(url)` either returns a stub response or raises an
    exception. `n_calls["n"]` is bumped on every call so the test can
    assert that the cache short-circuited a second invocation."""

    class _StubClient:
        def __init__(self, *a: Any, **k: Any) -> None:
            pass

        async def __aenter__(self) -> "_StubClient":
            return self

        async def __aexit__(self, *a: Any) -> bool:
            return False

        async def get(self, url: str) -> Any:
            n_calls["n"] += 1
            return behaviour(url)

    return _StubClient


@pytest.mark.asyncio
async def test_web_fetch_url_failure_is_cached_within_cell(monkeypatch) -> None:
    """SSL error, 4xx, and empty body should all be cached per-URL so the
    second dispatch returns the empty-hint pattern without re-fetching."""
    url = "https://broken.example.test/path?x=1"

    # --- SSL failure ----------------------------------------------------
    ssl_n = {"n": 0}

    def _ssl(_url: str) -> Any:
        raise httpx.ConnectError("ssl handshake failed")

    monkeypatch.setattr(
        web_fetch_mod.httpx, "AsyncClient", _stub_client_factory(_ssl, ssl_n)
    )

    reg = ToolRegistry(persona_type="expert")
    out1 = await reg.dispatch("web_fetch", {"url": url})
    assert out1["snippets"] == []
    assert ssl_n["n"] == 1
    # The cache must now hold a reason for this URL.
    assert reg._failed_urls, "fetch failure should have populated the cache"

    # Second call to the same URL must NOT issue a network request.
    out2 = await reg.dispatch("web_fetch", {"url": url})
    assert out2["snippets"] == []
    assert "already failed" in out2.get("hint", "").lower()
    assert ssl_n["n"] == 1, "second dispatch must not call httpx again"

    # --- 404 ------------------------------------------------------------
    not_found_n = {"n": 0}

    class _404Resp:
        status_code = 404
        headers = {"content-type": "text/html"}
        text = "not found"
        url = "https://other.example.test/missing"

    def _404(_url: str) -> Any:
        return _404Resp()

    monkeypatch.setattr(
        web_fetch_mod.httpx, "AsyncClient", _stub_client_factory(_404, not_found_n)
    )
    reg2 = ToolRegistry(persona_type="expert")
    nf_url = "https://other.example.test/missing"
    nf1 = await reg2.dispatch("web_fetch", {"url": nf_url})
    assert nf1["snippets"] == []
    assert not_found_n["n"] == 1
    nf2 = await reg2.dispatch("web_fetch", {"url": nf_url})
    assert nf2["snippets"] == []
    assert "already failed" in nf2.get("hint", "").lower()
    assert "http_404" in nf2.get("hint", "")
    assert not_found_n["n"] == 1

    # --- empty body -----------------------------------------------------
    empty_n = {"n": 0}

    class _EmptyResp:
        status_code = 200
        headers = {"content-type": "text/html"}
        text = "<html><head></head><body></body></html>"
        url = "https://empty.example.test/page"

    def _empty(_url: str) -> Any:
        return _EmptyResp()

    monkeypatch.setattr(
        web_fetch_mod.httpx, "AsyncClient", _stub_client_factory(_empty, empty_n)
    )
    reg3 = ToolRegistry(persona_type="expert")
    e_url = "https://empty.example.test/page"
    e1 = await reg3.dispatch("web_fetch", {"url": e_url})
    assert e1["snippets"] == []
    assert empty_n["n"] == 1
    e2 = await reg3.dispatch("web_fetch", {"url": e_url})
    assert e2["snippets"] == []
    assert "already failed" in e2.get("hint", "").lower()
    assert "empty_body" in e2.get("hint", "")
    assert empty_n["n"] == 1


# ---------------------------------------------------------------------------
# Fix 3: perspective loop bails after N consecutive unproductive iterations.
# ---------------------------------------------------------------------------


def _tool_use_block(block_id: str, name: str, input_: dict[str, Any]) -> SimpleNamespace:
    return SimpleNamespace(type="tool_use", id=block_id, name=name, input=input_)


def _text_block(text: str) -> SimpleNamespace:
    return SimpleNamespace(type="text", text=text)


def _resp(stop_reason: str, blocks: list[SimpleNamespace]) -> SimpleNamespace:
    return SimpleNamespace(stop_reason=stop_reason, content=blocks)


@pytest.mark.asyncio
async def test_perspective_bails_after_two_unproductive_iters(monkeypatch) -> None:
    """When every tool_result comes back empty for two iterations in a
    row, the perspective must bail to the dead-tools synthesis prompt
    instead of burning the full MAX_TOOL_ITERATIONS=6 round-trips."""
    persona = Persona(
        id="p1",
        name="P1",
        role="r",
        lens="l",
        description="d",
        system_prompt="s",
        persona_type="expert",
    )

    create_calls: list[dict[str, Any]] = []
    final_synthesis_text = "FORCED-SYNTHESIS-ANSWER-FROM-TRAINING-DATA"

    async def fake_create(**kwargs: Any) -> SimpleNamespace:
        create_calls.append(kwargs)
        n = len(create_calls)
        # First two round-trips: emit a single tool_use block, no text.
        if n <= 2:
            return _resp(
                "tool_use",
                [_tool_use_block(f"tu{n}", "web_browse", {"query": f"q{n}"})],
            )
        # Third round-trip is the forced synthesis (no tools available).
        return _resp("end_turn", [_text_block(final_synthesis_text)])

    client = SimpleNamespace(messages=SimpleNamespace(create=fake_create))

    agent = PerspectiveAgent(
        client=client,
        persona=persona,
        question="What's the headline?",
        dataset_schema="(no schema for test)",
    )

    # Every tool dispatch returns the empty-hint shape — simulating the
    # dispatcher short-circuiting dead URLs / cached failures.
    async def empty_dispatch(name: str, args: dict[str, Any]) -> dict[str, Any]:
        return {
            "snippets": [],
            "query": args.get("query") or args.get("url", ""),
            "hint": "(simulated: all tools dead)",
        }

    agent.registry.dispatch = empty_dispatch  # type: ignore[assignment]

    turn = await agent.answer("What's the headline?", DialogueMemory(), turn_idx=0)

    # Bail must happen before iter 6. With max_unproductive_tool_iters=2
    # (default), we expect: 2 unproductive iters + 1 forced synthesis
    # call = 3 round-trips, well under the 4-call ceiling spelled out in
    # the spec ("≤ 4 round-trips, not 6+").
    assert len(create_calls) <= 4, (
        f"expected ≤ 4 client.messages.create calls, got {len(create_calls)}"
    )
    # The forced-synthesis call must use the DEAD_TOOLS prompt as the
    # final user message — that's what tells Sonnet to lean on training
    # data instead of more (empty) tool results.
    final_kwargs = create_calls[-1]
    final_user_msg = final_kwargs["messages"][-1]
    assert final_user_msg["role"] == "user"
    assert final_user_msg["content"] == DEAD_TOOLS_SYNTHESIS_PROMPT
    # And the returned answer is the synthesis text the mock produced.
    assert final_synthesis_text in turn.answer

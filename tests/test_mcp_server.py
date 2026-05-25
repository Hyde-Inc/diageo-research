"""Tests for the MCP server that exposes the workbench as tool calls.

Strategy
--------
We don't want a stdio MCP integration test in CI — that requires
transports the harness doesn't supply. Instead we:

1. Verify the FastMCP app registers the tools we expect
   (so a typo'd ``@mcp.tool()`` decorator can't ship without breaking
   tests).
2. Drive each tool body with the workbench mocked via :class:`httpx.MockTransport`,
   to confirm the tool dispatch hits the right URL and forwards the
   response.
3. Add a focused test for ``get_axis_sensitivity``, which is the one
   tool that does real computation rather than passthrough.

That gives us coverage of the dispatch table + the one bit of logic
without standing up a stdio client / server pair.
"""
from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from diageo_research import mcp_server


EXPECTED_TOOLS = {
    "list_studies",
    "get_study",
    "get_spec_curve",
    "get_axis_sensitivity",
    "get_cost_rollup",
    "list_run_materializations",
    "get_run_manifest",
    "get_run_stage",
    "get_asset_graph",
    "list_recipes",
    "workbench_health",
}


def test_all_expected_tools_registered() -> None:
    """The MCP server must register every documented tool, with a non-
    empty docstring (the description that LLMs see)."""
    tools = mcp_server.mcp._tool_manager._tools
    assert set(tools.keys()) == EXPECTED_TOOLS, sorted(tools.keys())
    for name, tool in tools.items():
        assert tool.description and len(tool.description) > 10, name


def _install_fake_workbench(
    monkeypatch: pytest.MonkeyPatch, routes: dict[str, Any]
) -> list[str]:
    """Replace ``mcp_server._client`` with one whose transport answers
    a fixed dict of ``path -> response_json``. Returns the list of
    paths the tools actually visited so tests can assert dispatch.
    """
    visited: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        visited.append(path)
        if path in routes:
            payload = routes[path]
            if isinstance(payload, list):
                return httpx.Response(200, json=payload)
            return httpx.Response(200, json=payload)
        return httpx.Response(404, json={"error": "not found"})

    transport = httpx.MockTransport(handler)

    def _fake_client() -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url="http://wb-test", transport=transport, timeout=5.0)

    monkeypatch.setattr(mcp_server, "_client", _fake_client)
    return visited


@pytest.mark.asyncio
async def test_list_studies_passthrough(monkeypatch: pytest.MonkeyPatch) -> None:
    visited = _install_fake_workbench(
        monkeypatch,
        {"/studies": [{"id": "study_a", "name": "A"}, {"id": "study_b", "name": "B"}]},
    )
    out = await mcp_server.list_studies(limit=1)
    assert "/studies" in visited
    assert out == {"studies": [{"id": "study_a", "name": "A"}]}


@pytest.mark.asyncio
async def test_get_study_and_spec_curve(monkeypatch: pytest.MonkeyPatch) -> None:
    visited = _install_fake_workbench(
        monkeypatch,
        {
            "/studies/study_a": {"id": "study_a", "cells": []},
            "/studies/study_a/spec_curve": {"rows": [], "cells": []},
        },
    )
    s = await mcp_server.get_study("study_a")
    c = await mcp_server.get_spec_curve("study_a")
    assert "/studies/study_a" in visited
    assert "/studies/study_a/spec_curve" in visited
    assert s["id"] == "study_a"
    assert c["rows"] == []


@pytest.mark.asyncio
async def test_axis_sensitivity_computes_per_axis_agreement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Lead recommendation has 3/3 agree on ``cohort=high`` and 1/3 on
    ``cohort=low``. The tool must surface that asymmetry with the
    correct fractions."""
    cells = [
        {"id": "c1", "axes": {"cohort": "high", "geo": "us"}},
        {"id": "c2", "axes": {"cohort": "high", "geo": "ca"}},
        {"id": "c3", "axes": {"cohort": "high", "geo": "uk"}},
        {"id": "c4", "axes": {"cohort": "low", "geo": "us"}},
        {"id": "c5", "axes": {"cohort": "low", "geo": "ca"}},
        {"id": "c6", "axes": {"cohort": "low", "geo": "uk"}},
    ]
    statuses = {
        "c1": "agree",
        "c2": "agree",
        "c3": "agree",
        "c4": "agree",
        "c5": "weaker",
        "c6": "flips",
    }
    _install_fake_workbench(
        monkeypatch,
        {
            "/studies/study_a": {"id": "study_a", "cells": cells},
            "/studies/study_a/spec_curve": {
                "rows": [
                    {
                        "representative": "Lead recommendation",
                        "robustness": 4 / 6,
                        "statuses": statuses,
                    }
                ],
                "cells": cells,
            },
        },
    )
    out = await mcp_server.get_axis_sensitivity("study_a")
    assert out["lead_recommendation"] == "Lead recommendation"
    cohort = out["axes"]["cohort"]
    assert cohort["high"]["agree"] == 3
    assert cohort["high"]["total"] == 3
    assert cohort["high"]["agree_pct"] == 1.0
    assert cohort["low"]["agree"] == 1
    assert cohort["low"]["total"] == 3
    assert pytest.approx(cohort["low"]["agree_pct"], abs=1e-6) == 1 / 3
    geo = out["axes"]["geo"]
    assert geo["us"]["agree"] == 2
    assert geo["us"]["total"] == 2
    assert geo["us"]["agree_pct"] == 1.0
    assert geo["ca"]["agree"] == 1
    assert geo["uk"]["agree"] == 1


@pytest.mark.asyncio
async def test_workbench_health_reports_asset_counts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_workbench(
        monkeypatch,
        {
            "/assets/graph": {
                "nodes": [{"id": "x"}, {"id": "y"}],
                "edges": [{"from": "x", "to": "y"}],
            }
        },
    )
    out = await mcp_server.workbench_health()
    assert out["ok"] is True
    assert out["asset_count"] == 2
    assert out["edge_count"] == 1


@pytest.mark.asyncio
async def test_workbench_health_returns_ok_false_when_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("simulated outage", request=_request)

    transport = httpx.MockTransport(handler)

    def _fake_client() -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url="http://wb-test", transport=transport, timeout=2.0)

    monkeypatch.setattr(mcp_server, "_client", _fake_client)
    out = await mcp_server.workbench_health()
    assert out["ok"] is False
    assert "simulated outage" in out["error"]


@pytest.mark.asyncio
async def test_passthrough_tools_route_to_expected_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Spot-check the passthrough tools so a ``f"/runs/{x}"`` typo fails
    fast. Each call should hit the corresponding workbench path."""
    visited = _install_fake_workbench(
        monkeypatch,
        {
            "/runs/r1/materializations": {"run_id": "r1", "materializations": []},
            "/runs/r1/manifest": {"stages": []},
            "/runs/r1/stages/03_interview_p1": {"slug": "03_interview_p1", "markdown": "..."},
            "/studies/study_a/cost": {"study_id": "study_a", "cells": []},
            "/studies/samples": [{"slug": "study_pricing_pressure", "name": "Pricing pressure"}],
            "/assets/graph": {"nodes": [], "edges": []},
        },
    )
    await mcp_server.list_run_materializations("r1")
    await mcp_server.get_run_manifest("r1")
    await mcp_server.get_run_stage("r1", "03_interview_p1")
    await mcp_server.get_cost_rollup("study_a")
    await mcp_server.list_recipes()
    await mcp_server.get_asset_graph()
    assert visited == [
        "/runs/r1/materializations",
        "/runs/r1/manifest",
        "/runs/r1/stages/03_interview_p1",
        "/studies/study_a/cost",
        "/studies/samples",
        "/assets/graph",
    ]

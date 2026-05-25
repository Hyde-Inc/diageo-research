"""MCP server exposing the Hypothesis Workbench as tool calls.

Why this exists
---------------
The workbench API at :mod:`diageo_research.web.api` already turns every
view (DAG, spec curve, lineage drawer, cost rollup, …) into a JSON
endpoint. That makes it cheap to wire each one up as an MCP tool, so
Cursor / Claude Desktop / Claude Code can drive the workbench from a
chat surface without a separate frontend.

The complementary path is `dagster-mcp <https://pypi.org/project/dagster-mcp/>`_,
which wraps Dagster's GraphQL API (``get_runs``, ``get_recent_materializations``,
``launch_job``, …). That one is the right tool once we run a persistent
Dagster webserver — we use ``DagsterInstance.ephemeral()`` today, so the
Dagster GraphQL surface isn't queryable across runs. The README has
notes on standing that up.

Run it locally
--------------
::

    diageo mcp --workbench-url http://localhost:8000

or wire it directly into Claude Desktop / Cursor / Claude Code via:

::

    {
      "mcpServers": {
        "diageo-workbench": {
          "command": "python",
          "args": ["-m", "diageo_research.mcp_server"],
          "env": {"WORKBENCH_URL": "http://localhost:8000"}
        }
      }
    }

The server runs over stdio (the MCP default for desktop clients).

Tool surface
------------
The exposed tools mirror the FastAPI views but are intentionally
chat-agnostic:

* ``list_studies``               — recent studies (id, name, status, started_at)
* ``get_study``                  — full study state (cells, axes, status)
* ``get_spec_curve``             — clustered recommendations + robustness
* ``get_axis_sensitivity``       — per-axis robustness on the lead recommendation
* ``get_cost_rollup``            — total + per-cell Anthropic spend
* ``list_run_materializations``  — Dagster AssetMaterialization records for a cell
* ``get_run_manifest``           — provenance manifest (input/output/code hashes)
* ``get_run_stage``              — markdown body of one stage artefact
* ``list_recipes``               — saved YAML study specs (templates)
* ``get_asset_graph``            — declared Dagster asset graph (nodes + edges)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

logger = logging.getLogger(__name__)

WORKBENCH_URL = os.environ.get("WORKBENCH_URL", "http://localhost:8000")

mcp = FastMCP("diageo-workbench")


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=WORKBENCH_URL, timeout=15.0)


async def _get(path: str, *, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """Convenience: GET ``path`` against the workbench, return JSON."""
    async with _client() as client:
        r = await client.get(path, params=params or {})
        if r.status_code >= 400:
            return {"error": f"{r.status_code} {r.reason_phrase}", "path": path, "body": r.text}
        try:
            return r.json()
        except json.JSONDecodeError:
            return {"error": "Non-JSON response", "path": path, "body": r.text}


# ----------------------------------------------------------------- Studies

@mcp.tool()
async def list_studies(limit: int = 20) -> dict[str, Any]:
    """List recently started multiverse studies (newest first).

    Args:
        limit: Maximum number of studies to return.
    """
    studies = await _get("/studies")
    if isinstance(studies, list):
        return {"studies": studies[:limit]}
    return studies


@mcp.tool()
async def get_study(study_id: str) -> dict[str, Any]:
    """Fetch the full state of one multiverse study, including the spec
    grid (axes), every cell's status, run_id, and elapsed time.

    Args:
        study_id: ID of the study (e.g. ``study_1c64233a5a``).
    """
    return await _get(f"/studies/{study_id}")


@mcp.tool()
async def get_spec_curve(study_id: str) -> dict[str, Any]:
    """Get the clustered recommendations + robustness scores across the
    multiverse. Use this to answer "which conclusions hold up across
    specifications" — robustness is a fraction in ``[0, 1]``.

    Args:
        study_id: ID of the study.
    """
    return await _get(f"/studies/{study_id}/spec_curve")


@mcp.tool()
async def get_axis_sensitivity(study_id: str) -> dict[str, Any]:
    """For each spec axis, partition cells by axis value and compute
    the fraction that agree with the top-ranked (most-robust)
    recommendation. Surfaces which dimensions of variation flip the
    conclusion.

    Args:
        study_id: ID of the study.
    """
    curve = await _get(f"/studies/{study_id}/spec_curve")
    study = await _get(f"/studies/{study_id}")
    if "error" in curve or "error" in study:
        return {"error": "could not load study or spec curve", "curve": curve, "study": study}
    rows = curve.get("rows", [])
    cells = study.get("cells", [])
    if not rows or not cells:
        return {"axes": {}, "lead_recommendation": None}
    lead = rows[0]
    axis_names = list(cells[0].get("axes", {}).keys())
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for axis in axis_names:
        buckets: dict[str, dict[str, int]] = {}
        for c in cells:
            v = c.get("axes", {}).get(axis)
            if v is None:
                continue
            b = buckets.setdefault(v, {"agree": 0, "total": 0})
            b["total"] += 1
            if (lead.get("statuses") or {}).get(c["id"]) == "agree":
                b["agree"] += 1
        out[axis] = {
            v: {
                "agree": b["agree"],
                "total": b["total"],
                "agree_pct": (b["agree"] / b["total"]) if b["total"] else None,
            }
            for v, b in buckets.items()
        }
    return {
        "lead_recommendation": lead.get("representative"),
        "lead_robustness": lead.get("robustness"),
        "axes": out,
    }


@mcp.tool()
async def get_cost_rollup(study_id: str) -> dict[str, Any]:
    """Aggregate Anthropic spend across the study and per cell. Returns
    cell-level ``cost_usd``, ``n_calls``, ``max_cost_usd`` (cap), and
    a study-wide total.

    Args:
        study_id: ID of the study.
    """
    return await _get(f"/studies/{study_id}/cost")


# ----------------------------------------------------------------- Per-run

@mcp.tool()
async def list_run_materializations(run_id: str) -> dict[str, Any]:
    """Per-stage Dagster ``AssetMaterialization`` receipts for one
    multiverse cell. Each record has ``asset_key``, ``partition_key``,
    ``timestamp``, ``spent_usd``, model id, and SHA-256 input/prompt/
    code/output hashes when the stage manifest is on disk.

    Args:
        run_id: The cell's run id (a.k.a. partition key in Dagster).
    """
    return await _get(f"/runs/{run_id}/materializations")


@mcp.tool()
async def get_run_manifest(run_id: str) -> dict[str, Any]:
    """Provenance manifest for a single cell — every stage's elapsed
    time, model, input/output/code hashes. Use it to prove a run is
    bit-identical to a prior one.

    Args:
        run_id: The cell's run id.
    """
    return await _get(f"/runs/{run_id}/manifest")


@mcp.tool()
async def get_run_stage(run_id: str, slug: str) -> dict[str, Any]:
    """Read the markdown body of one stage artefact (e.g. ``00_question``,
    ``02_seed_outline``, ``07_final_outline``).

    Args:
        run_id: The cell's run id.
        slug: Filename slug under ``runs/<run_id>/`` (without ``.md``).
    """
    return await _get(f"/runs/{run_id}/stages/{slug}")


# ----------------------------------------------------------------- Assets

@mcp.tool()
async def get_asset_graph() -> dict[str, Any]:
    """Declared Dagster asset graph (nodes + edges). The same graph
    powers the DAG view and is sourced from the Dagster ``Definitions``
    on the backend.
    """
    return await _get("/assets/graph")


@mcp.tool()
async def list_recipes() -> dict[str, Any]:
    """Saved YAML study specs in ``samples/`` — these are 'recipes'
    that can be cloned and parameterized to start new studies. Each
    recipe captures a question, axes, defaults (max_cost_usd, n_personas),
    pre-registration, and falsifier conditions.
    """
    return await _get("/studies/samples")


# ----------------------------------------------------------------- Meta

@mcp.tool()
async def workbench_health() -> dict[str, Any]:
    """Sanity check: verify the workbench is reachable and report the
    configured URL.
    """
    try:
        async with _client() as client:
            r = await client.get("/assets/graph")
            r.raise_for_status()
            graph = r.json()
        return {
            "ok": True,
            "workbench_url": WORKBENCH_URL,
            "asset_count": len(graph.get("nodes", [])),
            "edge_count": len(graph.get("edges", [])),
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "workbench_url": WORKBENCH_URL, "error": str(e)}


def main() -> None:
    """Entry point used by ``python -m diageo_research.mcp_server``.

    Defaults to stdio transport, which is what Claude Desktop / Cursor
    / Claude Code expect. Set ``MCP_TRANSPORT=sse`` to expose the
    server over SSE for browser-based clients (and an MCP UI host).
    """
    transport = os.environ.get("MCP_TRANSPORT", "stdio").lower()
    if transport == "sse":
        # FastMCP's built-in SSE transport binds to MCP_HOST:MCP_PORT.
        host = os.environ.get("MCP_HOST", "127.0.0.1")
        port = int(os.environ.get("MCP_PORT", "8765"))
        logger.info("Starting diageo-workbench MCP on SSE %s:%d → %s", host, port, WORKBENCH_URL)
        asyncio.run(mcp.run_sse_async(host=host, port=port))
    else:
        logger.info("Starting diageo-workbench MCP over stdio → %s", WORKBENCH_URL)
        mcp.run()


if __name__ == "__main__":
    main()

"""Tests for the Dagster declarative asset graph + executor wiring.

Pins:

1. The graph the FE renders (via ``GET /assets/graph``) matches the
   ``deps=[...]`` declared inside the ``@asset`` decorators.
2. :data:`STAGE_SPEC` and the live Dagster introspection cannot drift
   apart silently.
3. ``GET /assets/graph`` returns the shape the FE expects
   (``{nodes, edges, partition_set}``) with the right counts.
4. Asset bodies are real adapters that call the matching stage on the
   parent event loop (proven by an end-to-end materialize against a
   stubbed StageContext registry).
5. Asset bodies fail loudly with a clear message if no StageContext is
   registered for the partition key.
"""
from __future__ import annotations

import asyncio
import threading
from typing import Any

import pytest
from dagster import (
    AssetKey,
    DagsterInstance,
    DynamicPartitionsDefinition,
    materialize,
)
from fastapi.testclient import TestClient

from diageo_research.dagster_assets import (
    ALL_ASSETS,
    STAGE_SPEC,
    asset_graph_json,
    cell_partitions,
    defs,
    register_stage_context,
    unregister_stage_context,
)
from diageo_research.web.api import app


# ----------------------------------------------------------- Spec consistency


def test_stage_spec_unique_keys() -> None:
    """Each stage key appears exactly once in the spec."""
    keys = [k for k, *_ in STAGE_SPEC]
    assert len(keys) == len(set(keys)), f"duplicate stage keys: {keys}"


def test_stage_spec_deps_reference_known_stages() -> None:
    """Every dep listed in the spec must itself be a declared stage."""
    keys = {k for k, *_ in STAGE_SPEC}
    for stage_key, _label, deps, _desc in STAGE_SPEC:
        for dep in deps:
            assert dep in keys, (
                f"stage {stage_key!r} references unknown dep {dep!r}; "
                f"declared stages: {sorted(keys)}"
            )


def test_stage_spec_deps_are_topologically_consistent() -> None:
    """A stage may only depend on stages declared earlier in STAGE_SPEC.

    This guards against accidentally introducing a forward reference
    when the spec is edited.
    """
    seen: set[str] = set()
    for stage_key, _label, deps, _desc in STAGE_SPEC:
        for dep in deps:
            assert dep in seen, (
                f"stage {stage_key!r} depends on {dep!r}, which is "
                f"declared later in STAGE_SPEC. Reorder STAGE_SPEC so "
                f"upstream stages come first."
            )
        seen.add(stage_key)


# ----------------------------------------------------------- Dagster declaration


def test_definitions_loads_six_assets() -> None:
    """The ``Definitions`` object lists exactly the six pipeline assets."""
    declared_keys = {
        AssetKey([key]) for key, *_ in STAGE_SPEC
    }
    actual_keys = {ad.key for ad in ALL_ASSETS}
    assert actual_keys == declared_keys
    assert len(ALL_ASSETS) == 6


def test_partition_set_is_dynamic_named_study_cells() -> None:
    """Cells use a dynamic partition set so studies can add cells live."""
    assert isinstance(cell_partitions, DynamicPartitionsDefinition)
    assert cell_partitions.name == "study_cells"


def test_every_asset_uses_cell_partitions() -> None:
    """All six assets are partitioned by the same cell-partition set."""
    for ad in ALL_ASSETS:
        assert ad.partitions_def is cell_partitions, (
            f"asset {ad.key} has a different partitions_def — multiverse "
            f"materialization needs every asset to share the cell partition set."
        )


def test_dagster_introspection_matches_stage_spec() -> None:
    """Dagster's resolved graph matches what STAGE_SPEC declares.

    This is the drift-prevention test: if someone edits ``deps=[...]``
    on a ``@asset`` without updating ``STAGE_SPEC`` (or vice versa),
    this fails.
    """
    asset_graph = defs.resolve_asset_graph()
    expected: dict[str, set[str]] = {
        key: set(deps) for key, _label, deps, _desc in STAGE_SPEC
    }
    for key, expected_deps in expected.items():
        node = asset_graph.get(AssetKey([key]))
        actual_deps = {
            parent.path[-1] for parent in node.parent_keys
        }
        assert actual_deps == expected_deps, (
            f"asset {key!r}: declared deps={sorted(actual_deps)}, "
            f"STAGE_SPEC says deps={sorted(expected_deps)} — these must agree."
        )


def _flatten_failure_messages(result: Any) -> str:
    """Concatenate every error message from a Dagster materialize result.

    Dagster wraps op exceptions in
    ``DagsterExecutionStepExecutionError`` and stashes the original
    error on ``StepFailureData.error.cause.message``. The user-visible
    text we care about (e.g. the message passed to ``RuntimeError``) is
    on the cause; the wrapping error message is just a generic envelope.
    """
    parts: list[str] = []
    for ev in result.all_events or []:
        if "FAILURE" not in str(ev.event_type_value):
            continue
        parts.append(str(ev.message or ""))
        esd = getattr(ev, "event_specific_data", None)
        err = getattr(esd, "error", None) if esd is not None else None
        if err is None:
            continue
        if getattr(err, "message", None):
            parts.append(str(err.message))
        cause = getattr(err, "cause", None)
        if cause is not None:
            parts.append(str(getattr(cause, "message", cause) or ""))
    return "\n".join(parts)


def test_asset_bodies_require_registered_stage_context() -> None:
    """Calling materialize without a registered StageContext fails loudly.

    Anything that calls ``dagster.materialize(ALL_ASSETS, ...)`` directly
    (without going through ``materialize_research_cell``) gets a pointed
    RuntimeError with a hint to use the right entry point. This is the
    guardrail against silent state corruption from re-entrant
    materialization.
    """
    instance = DagsterInstance.ephemeral()
    instance.add_dynamic_partitions("study_cells", ["unregistered-cell"])
    result = materialize(
        [ALL_ASSETS[0]],  # just question_analysis is enough
        partition_key="unregistered-cell",
        instance=instance,
        raise_on_error=False,
    )
    assert not result.success
    failure_messages = _flatten_failure_messages(result)
    assert "No StageContext registered" in failure_messages, failure_messages
    assert "materialize_research_cell" in failure_messages, failure_messages


# ---------------------------------------------------------------- JSON shape


def test_asset_graph_json_shape() -> None:
    g = asset_graph_json()
    assert set(g.keys()) == {"nodes", "edges", "partition_set"}
    assert g["partition_set"] == "study_cells"
    assert len(g["nodes"]) == 6


def test_asset_graph_json_node_shape() -> None:
    g = asset_graph_json()
    for node in g["nodes"]:
        assert set(node.keys()) >= {"id", "label", "description", "deps", "group"}
        assert isinstance(node["deps"], list)
        assert node["group"] == "research_pipeline"


def test_asset_graph_json_node_order_matches_stage_spec() -> None:
    """Nodes appear in the topological order declared in STAGE_SPEC.

    Stable ordering keeps the rendered DAG deterministic between
    page loads.
    """
    g = asset_graph_json()
    declared_order = [k for k, *_ in STAGE_SPEC]
    actual_order = [n["id"] for n in g["nodes"]]
    assert actual_order == declared_order


def test_asset_graph_json_edges_match_declared_deps() -> None:
    g = asset_graph_json()
    expected_edges: set[tuple[str, str]] = set()
    for stage_key, _label, deps, _desc in STAGE_SPEC:
        for dep in deps:
            expected_edges.add((dep, stage_key))
    actual_edges = {(e["from"], e["to"]) for e in g["edges"]}
    assert actual_edges == expected_edges


def test_asset_graph_json_edge_count_is_richer_than_linear_chain() -> None:
    """The declared graph must be more than a linear chain.

    Sanity check that we actually got something out of declarative
    deps — synthesis fans in from three upstreams, outline fans in
    from two, etc. A linear chain would have only 5 edges; we expect
    9 from STAGE_SPEC.
    """
    g = asset_graph_json()
    expected = sum(len(deps) for _k, _l, deps, _d in STAGE_SPEC)
    assert len(g["edges"]) == expected
    assert len(g["edges"]) > len(STAGE_SPEC) - 1, (
        "graph appears to be a linear chain — check that synthesis "
        "and outline have multiple upstream deps"
    )


# ----------------------------------------------------------------- HTTP route


def test_assets_graph_endpoint_returns_graph() -> None:
    client = TestClient(app)
    r = client.get("/assets/graph")
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == {"nodes", "edges", "partition_set"}
    assert body["partition_set"] == "study_cells"
    assert len(body["nodes"]) == 6
    assert len(body["edges"]) == 9


def test_assets_graph_endpoint_matches_python_helper() -> None:
    """HTTP response must equal the result of calling asset_graph_json()."""
    client = TestClient(app)
    body = client.get("/assets/graph").json()
    assert body == asset_graph_json()


# ----------------------------------------- End-to-end executor (stubbed I/O)


class _StubStageContext:
    """Drop-in for :class:`StageContext` that records which stages ran.

    Asset bodies access :attr:`run_id`, :attr:`parent_loop`,
    :attr:`run_dir` (for the materialization receipt JSONL),
    :attr:`cost_tracker`, and the stage-output attributes the metadata
    renderer reads. Plus a ``stages_invoked`` list the test asserts on.
    """

    def __init__(
        self,
        run_id: str,
        parent_loop: asyncio.AbstractEventLoop,
        run_dir,
    ):
        self.run_id = run_id
        self.parent_loop = parent_loop
        self.run_dir = run_dir
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.stages_invoked: list[str] = []
        # Attributes the metadata renderer reads:
        self.plan = None
        self.personas = []
        self.seed_sections = []
        self.sub_reports = []
        self.verified_count = 0
        self.flagged_count = 0
        self.final = None

        class _StubBreakdown:
            n_calls = 0

        class _StubCostTracker:
            cost_usd = 0.0
            breakdown = _StubBreakdown()

        self.cost_tracker = _StubCostTracker()


@pytest.mark.asyncio
async def test_materialize_through_dagster_drives_stage_functions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: dagster.materialize() must run every asset body and
    each asset body must schedule its stage coroutine on the parent
    loop. Stub the six stage functions in :mod:`dagster_assets` so we
    don't need a real Anthropic client; assert each was awaited
    exactly once and in topological order.
    """
    from diageo_research import dagster_assets as da

    invocation_order: list[str] = []
    invocation_lock = threading.Lock()

    async def _make_stub(stage_name: str):
        async def _stub(ctx: Any) -> None:
            with invocation_lock:
                invocation_order.append(stage_name)
                ctx.stages_invoked.append(stage_name)
            # Yield once so we exercise the run_coroutine_threadsafe ↔ await path.
            await asyncio.sleep(0)
        return _stub

    # Patch the symbols asset bodies look up by name.
    for stage_name in [
        "stage_question_analysis",
        "stage_personas",
        "stage_outline",
        "stage_interviews",
        "stage_verifier",
        "stage_synthesis",
    ]:
        stub = await _make_stub(stage_name)
        monkeypatch.setattr(da, stage_name, stub)

    # Register a stub context, run materialize through Dagster's executor.
    parent_loop = asyncio.get_running_loop()
    cell_id = "stub-cell"
    from diageo_research.config import get_settings
    run_dir = get_settings().runs_dir / cell_id
    ctx = _StubStageContext(run_id=cell_id, parent_loop=parent_loop, run_dir=run_dir)
    register_stage_context(cell_id, ctx)
    try:
        instance = DagsterInstance.ephemeral()
        instance.add_dynamic_partitions("study_cells", [cell_id])

        def _materialize() -> Any:
            return materialize(
                ALL_ASSETS,
                partition_key=cell_id,
                instance=instance,
                raise_on_error=False,
            )

        result = await asyncio.to_thread(_materialize)
    finally:
        unregister_stage_context(cell_id)

    assert result.success, [
        ev.message for ev in (result.all_events or []) if ev.is_failure
    ]

    # Every stage must have been invoked exactly once.
    expected = [
        "stage_question_analysis",
        "stage_personas",
        "stage_outline",
        "stage_interviews",
        "stage_verifier",
        "stage_synthesis",
    ]
    assert sorted(invocation_order) == sorted(expected), invocation_order
    # And the topological order must respect declared deps.
    pos = {name: invocation_order.index(name) for name in expected}
    assert pos["stage_question_analysis"] < pos["stage_personas"]
    assert pos["stage_personas"] < pos["stage_outline"]
    assert pos["stage_outline"] < pos["stage_interviews"]
    assert pos["stage_interviews"] < pos["stage_verifier"]
    assert pos["stage_verifier"] < pos["stage_synthesis"]
    # And the StageContext got mutated by every stage.
    assert ctx.stages_invoked == invocation_order


@pytest.mark.asyncio
async def test_materialize_propagates_stage_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If a stage coroutine raises, the asset's step fails and dagster's
    result reflects the failure (so the multiverse cell is marked
    errored cleanly)."""
    from diageo_research import dagster_assets as da

    async def _ok(ctx: Any) -> None:
        await asyncio.sleep(0)

    async def _boom(ctx: Any) -> None:
        raise RuntimeError("intentional failure from stage_personas")

    monkeypatch.setattr(da, "stage_question_analysis", _ok)
    monkeypatch.setattr(da, "stage_personas", _boom)

    parent_loop = asyncio.get_running_loop()
    cell_id = "stub-cell-error"
    from diageo_research.config import get_settings
    run_dir = get_settings().runs_dir / cell_id
    ctx = _StubStageContext(run_id=cell_id, parent_loop=parent_loop, run_dir=run_dir)
    register_stage_context(cell_id, ctx)
    try:
        instance = DagsterInstance.ephemeral()
        instance.add_dynamic_partitions("study_cells", [cell_id])

        def _materialize() -> Any:
            return materialize(
                ALL_ASSETS,
                partition_key=cell_id,
                instance=instance,
                raise_on_error=False,
            )

        result = await asyncio.to_thread(_materialize)
    finally:
        unregister_stage_context(cell_id)

    assert not result.success
    failure_messages = _flatten_failure_messages(result)
    assert "intentional failure from stage_personas" in failure_messages, failure_messages


@pytest.mark.asyncio
async def test_materialize_writes_per_stage_receipts_to_jsonl(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Each successful asset body appends one JSONL line to
    runs/<run_id>/dagster_materializations.jsonl, and the matching
    /runs/<run_id>/materializations endpoint returns those receipts.
    """
    from diageo_research import dagster_assets as da
    from diageo_research.config import get_settings

    async def _ok(ctx: Any) -> None:
        await asyncio.sleep(0)

    for stage_name in [
        "stage_question_analysis",
        "stage_personas",
        "stage_outline",
        "stage_interviews",
        "stage_verifier",
        "stage_synthesis",
    ]:
        monkeypatch.setattr(da, stage_name, _ok)

    parent_loop = asyncio.get_running_loop()
    cell_id = "stub-cell-receipts"
    run_dir = get_settings().runs_dir / cell_id
    ctx = _StubStageContext(run_id=cell_id, parent_loop=parent_loop, run_dir=run_dir)
    register_stage_context(cell_id, ctx)
    try:
        instance = DagsterInstance.ephemeral()
        instance.add_dynamic_partitions("study_cells", [cell_id])

        def _materialize() -> Any:
            return materialize(
                ALL_ASSETS,
                partition_key=cell_id,
                instance=instance,
                raise_on_error=False,
            )

        result = await asyncio.to_thread(_materialize)
    finally:
        unregister_stage_context(cell_id)

    assert result.success
    receipts_path = run_dir / "dagster_materializations.jsonl"
    assert receipts_path.exists(), receipts_path
    lines = [
        line for line in receipts_path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]
    import json as _json

    receipts = [_json.loads(line) for line in lines]
    asset_keys = sorted(r["asset_key"] for r in receipts)
    assert asset_keys == sorted(
        [
            "question_analysis",
            "personas",
            "outline",
            "interviews",
            "verifier",
            "synthesis",
        ]
    )
    for r in receipts:
        assert r["partition_key"] == cell_id
        assert r["run_id"] == cell_id
        assert "timestamp" in r
        assert "spent_usd" in r
        assert "n_calls" in r

    # And the FastAPI endpoint surfaces the same receipts.
    client = TestClient(app)
    r = client.get(f"/runs/{cell_id}/materializations")
    assert r.status_code == 200
    body = r.json()
    assert body["run_id"] == cell_id
    assert body["partition_set"] == "study_cells"
    assert len(body["materializations"]) == 6
    assert sorted(m["asset_key"] for m in body["materializations"]) == asset_keys

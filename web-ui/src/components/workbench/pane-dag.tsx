'use client';

/**
 * Workbench DAG / Lineage pane.
 *
 * Renders the declared Dagster asset graph from
 * GET /api/workbench/assets/graph using @xyflow/react. Auto-layout via
 * dagre (left → right) because Dagster's six-stage pipeline is shallow
 * and reads best as a horizontal chain.
 *
 * Clicking a node selects that asset and pops a small scannable summary
 * to the right: artifact name, group, dependencies, the latest
 * materialization for the currently selected cell, and a button that
 * jumps into the producing cell's detail sheet — so the audience never
 * has to read raw materialization JSON to answer "what does this do".
 *
 * Why React Flow + dagre rather than inline SVG: the asset graph has
 * fan-in (Synthesis ← Outline, Interviews, Verifier) and a hand-rolled
 * SVG cluster would either get the crossings wrong or need its own
 * layout solver. dagre is what Dagster's own UI uses.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  getSmoothStepPath,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Circle,
  Clock,
  FileBox,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  wb,
  type AssetGraph,
  type AssetNode,
  type CellSummary,
  type Materialization,
  type SpecCurve,
} from './types';
import { PaneCard, PaneDeck, PaneEmpty, PaneGrid } from './pane-layout';
import { CellDetailSheet, type CellDetailContext } from './cell-detail-sheet';

const NODE_WIDTH = 240;
const NODE_HEIGHT = 84;

// ─── Layout ────────────────────────────────────────────────────────

function layoutWithDagre(graph: AssetGraph): {
  nodes: StageNodeT[];
  edges: Edge[];
} {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'LR',
    nodesep: 28,
    ranksep: 56,
    marginx: 12,
    marginy: 12,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of graph.nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const e of graph.edges) {
    g.setEdge(e.from, e.to);
  }
  dagre.layout(g);

  const nodes: StageNodeT[] = graph.nodes.map((n) => {
    const positioned = g.node(n.id);
    return {
      id: n.id,
      position: {
        x: positioned.x - NODE_WIDTH / 2,
        y: positioned.y - NODE_HEIGHT / 2,
      },
      data: {
        id: n.id,
        label: n.label,
        description: n.description,
        depCount: n.deps.length,
      },
      type: 'stage',
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };
  });

  const edges: Edge[] = graph.edges.map((e, i) => ({
    id: `e_${i}_${e.from}__${e.to}`,
    source: e.from,
    target: e.to,
    type: 'workbench',
    animated: false,
  }));

  return { nodes, edges };
}

// ─── Node + edge components ────────────────────────────────────────

type StageStatus = 'idle' | 'running' | 'complete' | 'error';

type AssetNodeData = {
  id: string;
  label: string;
  description: string;
  depCount: number;
  status?: StageStatus;
  spent_usd?: number;
  model_id?: string;
  highlighted?: boolean;
  // @xyflow/react v12 needs node data to widen to a Record<string, unknown>
  // for its generic constraint. Adding an index signature keeps the
  // strongly-typed fields above usable while satisfying the lib type.
  [key: string]: unknown;
};

type StageNodeT = Node<AssetNodeData, 'stage'>;
type AssetGraphFetch = {
  key: number;
  graph: AssetGraph | null;
  error: string | null;
};
type MaterializationFetch = {
  runId: string;
  materializations: Materialization[];
};

function StageNode({ data }: NodeProps<StageNodeT>) {
  const status = data.status ?? 'idle';
  return (
    <div
      className={cn(
        'grid h-[84px] w-[240px] gap-1 rounded-xl border bg-white px-3 py-2 text-left shadow-sm transition-colors',
        statusBorder(status),
        data.highlighted && 'ring-2 ring-slate-950/60',
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-slate-400" />
      <Handle type="source" position={Position.Right} className="!bg-slate-400" />
      <div className="flex items-center gap-1.5">
        <StatusIcon status={status} />
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
          {data.id}
        </span>
        <span className="ml-auto text-[9px] text-slate-500">
          {data.depCount} dep{data.depCount === 1 ? '' : 's'}
        </span>
      </div>
      <div className="text-[11px] font-semibold leading-snug">{data.label}</div>
      <div className="flex items-center gap-2 font-mono text-[9px] text-slate-500">
        {data.model_id ? <span>{data.model_id}</span> : null}
        {data.spent_usd != null ? <span>${data.spent_usd.toFixed(4)}</span> : null}
      </div>
    </div>
  );
}

function WorkbenchEdge(props: EdgeProps) {
  const [d] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
    borderRadius: 8,
  });
  return (
    <BaseEdge
      id={props.id}
      path={d}
      style={{
        stroke: '#94a3b8',
        strokeWidth: 1.2,
      }}
    />
  );
}

const nodeTypes = { stage: StageNode } as unknown as Record<string, React.ComponentType<NodeProps>>;
const edgeTypes = { workbench: WorkbenchEdge };

// ─── Pane ──────────────────────────────────────────────────────────

export function PaneDag({
  curve,
  loading: curveLoading,
  cellId,
  onSelectCell,
  onOpenInLineage: _onOpenInLineage,
}: {
  curve: SpecCurve | null;
  loading: boolean;
  cellId: string | null;
  onSelectCell: (cellId: string) => void;
  onOpenInLineage?: (cellId: string) => void;
}) {
  void _onOpenInLineage;

  const [graphFetch, setGraphFetch] = useState<AssetGraphFetch | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [matsFetch, setMatsFetch] = useState<MaterializationFetch | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [detailCtx, setDetailCtx] = useState<CellDetailContext | null>(null);

  const selectedCell: CellSummary | null = useMemo(() => {
    if (!curve || !cellId) return null;
    return curve.cells.find((c) => c.id === cellId) ?? null;
  }, [curve, cellId]);

  // Auto-pick the first complete cell on first load so the DAG never
  // sits in "no cell selected" once we have data.
  useEffect(() => {
    if (cellId || !curve || curve.cells.length === 0) return;
    const first =
      curve.cells.find((c) => c.status === 'complete') ?? curve.cells[0];
    if (first) onSelectCell(first.id);
  }, [cellId, curve, onSelectCell]);

  useEffect(() => {
    let cancelled = false;
    wb.assetGraph()
      .then((g) => {
        if (!cancelled) {
          setGraphFetch({ key: refreshKey, graph: g, error: null });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setGraphFetch({
          key: refreshKey,
          graph: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const selectedRunId = selectedCell?.run_id ?? null;

  useEffect(() => {
    if (!selectedRunId) return;
    let cancelled = false;
    wb.materializations(selectedRunId)
      .then((res) => {
        if (cancelled) return;
        setMatsFetch({
          runId: selectedRunId,
          materializations: res.materializations,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setMatsFetch({ runId: selectedRunId, materializations: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  const currentGraph =
    graphFetch?.key === refreshKey
      ? { graph: graphFetch.graph, error: graphFetch.error }
      : { graph: null, error: null };
  const graph = currentGraph.graph;
  const graphError = currentGraph.error;
  const mats =
    selectedRunId && matsFetch?.runId === selectedRunId
      ? matsFetch.materializations
      : null;

  const matByStage = useMemo(() => {
    const m = new Map<string, Materialization>();
    for (const x of mats ?? []) m.set(x.stage, x);
    return m;
  }, [mats]);

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as StageNodeT[], edges: [] as Edge[] };
    const { nodes: laidOut, edges: laidEdges } = layoutWithDagre(graph);
    const enriched: StageNodeT[] = laidOut.map((node) => {
      const m = matByStage.get(node.data.id);
      const status: StageStatus = m ? 'complete' : selectedCell ? 'running' : 'idle';
      return {
        ...node,
        data: {
          ...node.data,
          status,
          spent_usd: m?.spent_usd,
          model_id: m?.model_id,
          highlighted: selectedAssetId === node.id,
        },
      };
    });
    return { nodes: enriched, edges: laidEdges };
  }, [graph, matByStage, selectedCell, selectedAssetId]);

  const handleNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      setSelectedAssetId(node.id);
    },
    [],
  );

  const selectedAsset: AssetNode | null = useMemo(() => {
    if (!graph || !selectedAssetId) return null;
    return graph.nodes.find((n) => n.id === selectedAssetId) ?? null;
  }, [graph, selectedAssetId]);

  const selectedMat = selectedAssetId
    ? matByStage.get(selectedAssetId) ?? null
    : null;

  return (
    <PaneDeck data-testid="pane-dag">
      <PaneGrid className="xl:grid-cols-3">
        <PaneCard
          title="Lineage / DAG"
          meta={`${graph?.nodes.length ?? 0} assets · ${graph?.edges.length ?? 0} deps`}
          description="The Dagster asset graph for one cell. Click an asset to see what it produces and which cell produced it."
          className="xl:col-span-2"
        >
          <DagLegend
            partitionSet={graph?.partition_set ?? 'study_cells'}
            onRefresh={() => setRefreshKey((k) => k + 1)}
            selectedCell={selectedCell}
          />
          {graphError ? (
            <PaneEmpty className="mt-2 border-orange-500/50 text-orange-500">
              Failed to load asset graph: {graphError}. Ensure the workbench API
              is reachable.
            </PaneEmpty>
          ) : !graph ? (
            <PaneEmpty className="mt-2 grid place-items-center">
              <Loader2 className="mb-2 h-4 w-4 animate-spin" />
              Fetching <code>/assets/graph</code>…
            </PaneEmpty>
          ) : (
            <div className="mt-3 h-[520px] overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
              <DagFlow
                nodes={nodes}
                edges={edges}
                onNodeClick={handleNodeClick}
              />
            </div>
          )}
        </PaneCard>

        <PaneCard
          title={selectedAsset ? 'Asset detail' : 'Pick an asset'}
          meta={selectedAsset?.id}
          description={
            selectedAsset
              ? 'What this asset produces and how the selected cell ran it.'
              : 'Click any node in the DAG to see a scannable summary here.'
          }
        >
          {selectedAsset ? (
            <AssetDetailCard
              asset={selectedAsset}
              materialization={selectedMat}
              cell={selectedCell}
              onOpenCell={() => {
                if (selectedCell && curve) {
                  setDetailCtx({ cell: selectedCell, rows: curve.rows });
                }
              }}
            />
          ) : curveLoading ? (
            <PaneEmpty className="text-[11px]">Loading study spec curve…</PaneEmpty>
          ) : !curve ? (
            <PaneEmpty className="text-[11px]">
              Pick a study to enrich DAG stages with cell materializations.
            </PaneEmpty>
          ) : (
            <CellRailSummary
              curve={curve}
              activeCellId={cellId}
              onSelect={onSelectCell}
            />
          )}
        </PaneCard>
      </PaneGrid>
      <CellDetailSheet
        ctx={detailCtx}
        onClose={() => setDetailCtx(null)}
        onOpenInLineage={undefined /* already in lineage */}
      />
    </PaneDeck>
  );
}

function AssetDetailCard({
  asset,
  materialization,
  cell,
  onOpenCell,
}: {
  asset: AssetNode;
  materialization: Materialization | null;
  cell: CellSummary | null;
  onOpenCell: () => void;
}) {
  const status: StageStatus = materialization
    ? 'complete'
    : cell
      ? 'running'
      : 'idle';
  return (
    <div className="grid gap-3">
      <div className="grid gap-1 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-100 text-slate-600">
            <FileBox className="h-3.5 w-3.5" />
          </span>
          <StatusBadge status={status} />
        </div>
        <div className="grid gap-0.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
            {asset.group ?? 'asset'}
          </span>
          <span className="text-sm font-semibold tracking-tight text-slate-900">
            {asset.label}
          </span>
          <span className="font-mono text-[11px] text-slate-500">{asset.id}</span>
        </div>
        {asset.description ? (
          <p className="mt-1 text-[12px] leading-snug text-slate-600">
            {asset.description}
          </p>
        ) : null}
      </div>

      {asset.deps.length > 0 ? (
        <div className="grid gap-1 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Depends on ({asset.deps.length})
          </span>
          <div className="flex flex-wrap gap-1">
            {asset.deps.map((dep) => (
              <Badge
                key={dep}
                variant="outline"
                className="border-slate-200 bg-slate-50 font-mono text-[10px] text-slate-600"
              >
                {dep}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <MaterializationSummary materialization={materialization} cell={cell} />

      {cell ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenCell}
          className="h-8 justify-between gap-2 rounded-full border-slate-200 bg-white text-xs shadow-sm hover:bg-slate-50"
        >
          <span>Open producing cell</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

function MaterializationSummary({
  materialization,
  cell,
}: {
  materialization: Materialization | null;
  cell: CellSummary | null;
}) {
  if (!materialization) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/70 p-3 text-[11px] text-slate-500">
        {cell
          ? 'No materialization for this asset on the selected cell yet.'
          : 'Select a cell to see this asset\u2019s last materialization.'}
      </div>
    );
  }
  const ts = (() => {
    try {
      return new Date(materialization.timestamp).toLocaleString();
    } catch {
      return materialization.timestamp;
    }
  })();
  const facts: Array<[string, string]> = [];
  facts.push(['Stage', materialization.stage]);
  if (materialization.partition_key) {
    facts.push(['Partition', materialization.partition_key]);
  }
  facts.push(['Last materialized', ts]);
  if (materialization.elapsed_s != null) {
    facts.push(['Elapsed', `${materialization.elapsed_s.toFixed(1)}s`]);
  }
  if (materialization.spent_usd != null) {
    facts.push(['Cost', `$${materialization.spent_usd.toFixed(4)}`]);
  }
  if (materialization.model_id) {
    facts.push(['Model', materialization.model_id]);
  }
  const extras = describeExtras(materialization);
  return (
    <div className="grid gap-2 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
        Last materialization
      </span>
      <dl className="grid gap-1.5 sm:grid-cols-2">
        {facts.map(([k, v]) => (
          <div key={k} className="grid gap-0.5">
            <dt className="text-[10px] font-mono uppercase tracking-wider text-slate-500">
              {k}
            </dt>
            <dd className="truncate font-mono text-[11px] text-slate-800" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      {extras.length > 0 ? (
        <div className="grid gap-0.5 rounded-lg border border-emerald-200/60 bg-white px-2 py-1.5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500">
            Output
          </span>
          <span className="text-[12px] leading-snug text-slate-700">
            {extras.join(' · ')}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function describeExtras(m: Materialization): string[] {
  const extras: string[] = [];
  if (m.complexity != null) extras.push(`complexity ${m.complexity}`);
  if (m.complexity_score != null) extras.push(`score ${m.complexity_score}`);
  if (m.recommended_personas != null) extras.push(`rec personas ${m.recommended_personas}`);
  if (m.n_personas != null) extras.push(`${m.n_personas} personas`);
  if (m.n_sections != null) extras.push(`${m.n_sections} sections`);
  if (m.n_subreports != null) extras.push(`${m.n_subreports} subreports`);
  if (m.total_citations != null) extras.push(`${m.total_citations} citations`);
  if (m.verified != null && m.flagged != null) {
    extras.push(`${m.verified} verified · ${m.flagged} flagged`);
  }
  if (m.markdown_len != null) extras.push(`${m.markdown_len} chars`);
  return extras;
}

function DagFlow({
  nodes,
  edges,
  onNodeClick,
}: {
  nodes: StageNodeT[];
  edges: Edge[];
  onNodeClick: (e: React.MouseEvent, node: Node) => void;
}) {
  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        elementsSelectable
        panOnScroll
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap pannable zoomable className="!bg-white" />
      </ReactFlow>
    </ReactFlowProvider>
  );
}

function DagLegend({
  partitionSet,
  onRefresh,
  selectedCell,
}: {
  partitionSet: string;
  onRefresh: () => void;
  selectedCell: CellSummary | null;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b pb-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-500">
          partitions: {partitionSet}
        </span>
      </div>
      <div className="flex items-center gap-3">
        {selectedCell ? (
          <span className="rounded-full bg-slate-100 px-2 py-1 font-mono text-xs text-slate-600">
            {selectedCell.id} · {selectedCell.status}
          </span>
        ) : (
          <span className="font-mono text-xs text-slate-500">
            no cell selected
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 rounded-full border-slate-200 bg-white px-3 text-xs shadow-sm hover:bg-slate-50"
          onClick={onRefresh}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>
    </div>
  );
}

function CellRailSummary({
  curve,
  activeCellId,
  onSelect,
}: {
  curve: SpecCurve;
  activeCellId: string | null;
  onSelect: (cellId: string) => void;
}) {
  if (curve.cells.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        This study has no cells materialized yet.
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <p className="text-[11px] text-slate-500">
        Pick a cell to fix the column the lineage view is reading from. Then
        click an asset in the graph for a scannable summary.
      </p>
      <div className="grid max-h-[440px] gap-1.5 overflow-y-auto pr-1">
        {curve.cells.map((cell) => (
          <button
            key={cell.id}
            type="button"
            onClick={() => onSelect(cell.id)}
            className={cn(
              'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-xl border bg-white px-2.5 py-1.5 text-left shadow-sm transition-colors',
              activeCellId === cell.id
                ? 'border-slate-950 bg-slate-50'
                : 'border-slate-200 hover:border-slate-400',
            )}
          >
            <CellStatusGlyph status={cell.status} />
            <div className="min-w-0">
              <div className="truncate font-mono text-xs">{cell.id}</div>
              <div className="truncate font-mono text-[11px] text-slate-500">
                {Object.entries(cell.axes)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' · ')}
              </div>
            </div>
            <Badge variant="outline" className="font-mono text-[11px]">
              {cell.n_recommendations} recs
            </Badge>
          </button>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: StageStatus }) {
  const tone =
    status === 'complete'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : status === 'running'
        ? 'border-blue-200 bg-blue-50 text-blue-700'
        : status === 'error'
          ? 'border-orange-200 bg-orange-50 text-orange-700'
          : 'border-slate-200 bg-slate-50 text-slate-600';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        tone,
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          status === 'complete' && 'bg-emerald-500',
          status === 'running' && 'animate-pulse bg-blue-500',
          status === 'error' && 'bg-orange-500',
          status === 'idle' && 'bg-slate-400',
        )}
      />
      {status === 'idle' ? 'pending' : status}
    </span>
  );
}

function StatusIcon({ status }: { status: StageStatus }) {
  const cls = 'h-3 w-3 shrink-0';
  if (status === 'complete')
    return <CheckCircle2 className={cn(cls, 'text-emerald-500')} />;
  if (status === 'running')
    return <Clock className={cn(cls, 'animate-pulse text-blue-500')} />;
  if (status === 'error')
    return <AlertCircle className={cn(cls, 'text-orange-500')} />;
  return <Circle className={cn(cls, 'text-slate-400')} />;
}

function CellStatusGlyph({ status }: { status: CellSummary['status'] }) {
  return <StatusIcon status={statusToStage(status)} />;
}

function statusToStage(s: CellSummary['status']): StageStatus {
  if (s === 'complete') return 'complete';
  if (s === 'running') return 'running';
  if (s === 'error') return 'error';
  return 'idle';
}

function statusBorder(status: StageStatus): string {
  if (status === 'complete') return 'border-emerald-300';
  if (status === 'running') return 'border-blue-300';
  if (status === 'error') return 'border-orange-300';
  return 'border-slate-200';
}

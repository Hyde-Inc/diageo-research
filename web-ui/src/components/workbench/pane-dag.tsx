'use client';

/**
 * Workbench DAG pane.
 *
 * Renders the declared Dagster asset graph from
 * GET /api/workbench/assets/graph using @xyflow/react. Auto-layout via
 * dagre (left → right) because Dagster's six-stage pipeline is shallow
 * and reads best as a horizontal chain. Click a node to open the cell
 * detail sheet for the currently selected cell, scrolled to that
 * stage's materialization record (if present).
 *
 * Why React Flow + dagre rather than inline SVG (which catalog-v2 uses
 * for the lineage view): the asset graph has fan-in (Synthesis ← Outline,
 * Interviews, Verifier) and a hand-rolled SVG cluster would either get
 * the crossings wrong or need its own layout solver. dagre is what
 * Dagster's own UI uses; reproducing that look here keeps the demo
 * legible to anyone who has seen the real product.
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
  CheckCircle2,
  Circle,
  Clock,
  Cpu,
  GitGraph,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  wb,
  type AssetGraph,
  type CellSummary,
  type Materialization,
  type SpecCurve,
} from './types';
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

function StageNode({ data }: NodeProps<StageNodeT>) {
  const status = data.status ?? 'idle';
  return (
    <div
      className={cn(
        'grid h-[84px] w-[240px] gap-1 border bg-background px-3 py-2 text-left shadow-sm transition-colors',
        statusBorder(status),
        data.highlighted && 'ring-2 ring-foreground/60',
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground/40" />
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground/40" />
      <div className="flex items-center gap-1.5">
        <StatusIcon status={status} />
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {data.id}
        </span>
        <span className="ml-auto text-[9px] text-muted-foreground">
          {data.depCount} dep{data.depCount === 1 ? '' : 's'}
        </span>
      </div>
      <div className="text-[11px] font-semibold leading-snug">{data.label}</div>
      <div className="flex items-center gap-2 font-mono text-[9px] text-muted-foreground">
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
        stroke: 'hsl(var(--muted-foreground) / 0.5)',
        strokeWidth: 1.2,
      }}
    />
  );
}

// Cast through unknown so v12's strict NodeTypes generic accepts our
// typed component without losing the StageNodeT inference inside it.
const nodeTypes = { stage: StageNode } as unknown as Record<string, React.ComponentType<NodeProps>>;
const edgeTypes = { workbench: WorkbenchEdge };

// ─── Pane ──────────────────────────────────────────────────────────

export function PaneDag({
  curve,
  loading: curveLoading,
  cellId,
  onSelectCell,
}: {
  curve: SpecCurve | null;
  loading: boolean;
  cellId: string | null;
  onSelectCell: (cellId: string) => void;
}) {
  const [graph, setGraph] = useState<AssetGraph | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [mats, setMats] = useState<Materialization[] | null>(null);
  const [matsRunId, setMatsRunId] = useState<string | null>(null);
  const [detailCtx, setDetailCtx] = useState<CellDetailContext | null>(null);

  const selectedCell: CellSummary | null = useMemo(() => {
    if (!curve || !cellId) return null;
    return curve.cells.find((c) => c.id === cellId) ?? null;
  }, [curve, cellId]);

  // Auto-pick the first complete cell on first load so the DAG never
  // sits in "no cell selected" once we have data. The parent owns
  // cellId so we only nudge it; never overwrite a deliberate selection.
  useEffect(() => {
    if (cellId || !curve || curve.cells.length === 0) return;
    const first =
      curve.cells.find((c) => c.status === 'complete') ?? curve.cells[0];
    if (first) onSelectCell(first.id);
  }, [cellId, curve, onSelectCell]);

  useEffect(() => {
    let cancelled = false;
    setGraphError(null);
    wb.assetGraph()
      .then((g) => {
        if (!cancelled) setGraph(g);
      })
      .catch((err) => {
        if (cancelled) return;
        setGraphError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    if (!selectedCell) {
      setMats(null);
      setMatsRunId(null);
      return;
    }
    if (matsRunId === selectedCell.run_id) return;
    let cancelled = false;
    setMatsRunId(selectedCell.run_id);
    wb.materializations(selectedCell.run_id)
      .then((res) => {
        if (cancelled) return;
        setMats(res.materializations);
      })
      .catch(() => {
        if (cancelled) return;
        setMats([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCell, matsRunId]);

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as StageNodeT[], edges: [] as Edge[] };
    const matByStage = new Map<string, Materialization>();
    for (const m of mats ?? []) {
      matByStage.set(m.stage, m);
    }
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
        },
      };
    });
    return { nodes: enriched, edges: laidEdges };
  }, [graph, mats, selectedCell]);

  const handleNodeClick = useCallback(
    (_evt: unknown, _node: StageNodeT) => {
      if (!selectedCell || !curve) return;
      setDetailCtx({ cell: selectedCell, rows: curve.rows });
    },
    [selectedCell, curve],
  );

  return (
    <div className="grid gap-3" data-testid="pane-dag">
      <DagLegend
        partitionSet={graph?.partition_set ?? 'study_cells'}
        onRefresh={() => setRefreshKey((k) => k + 1)}
        nodeCount={graph?.nodes.length ?? 0}
        edgeCount={graph?.edges.length ?? 0}
        selectedCell={selectedCell}
      />

      {graphError ? (
        <div className="border bg-muted/20 p-4 text-[11px] text-orange-500">
          Failed to load asset graph: {graphError}. The FastAPI workbench
          must be running on http://127.0.0.1:8765 (or set
          <code className="mx-1 font-mono">WORKBENCH_API_BASE</code> in
          the FE&apos;s .env.local).
        </div>
      ) : !graph ? (
        <div className="grid place-items-center border bg-muted/10 p-8 text-[11px] text-muted-foreground">
          <Loader2 className="mb-2 h-4 w-4 animate-spin" />
          Fetching <code>/assets/graph</code>…
        </div>
      ) : (
        <div className="h-[560px] border bg-muted/5">
          <DagFlow
            nodes={nodes}
            edges={edges}
            onNodeClick={handleNodeClick}
          />
        </div>
      )}

      {curveLoading ? (
        <div className="border bg-muted/20 p-2 text-[10px] text-muted-foreground">
          Loading study spec curve…
        </div>
      ) : !curve ? (
        <div className="border bg-muted/20 p-2 text-[10px] text-muted-foreground">
          Pick a study to enrich the DAG with cell-level materializations.
        </div>
      ) : (
        <CellRailSummary
          curve={curve}
          activeCellId={cellId}
          onSelect={onSelectCell}
        />
      )}

      <CellDetailSheet ctx={detailCtx} onClose={() => setDetailCtx(null)} />
    </div>
  );
}

function DagFlow({
  nodes,
  edges,
  onNodeClick,
}: {
  nodes: StageNodeT[];
  edges: Edge[];
  onNodeClick: (evt: unknown, node: StageNodeT) => void;
}) {
  // We re-derive nodes/edges from props on every change rather than
  // using useNodesState (whose change types are noisy in v12). The
  // graph is tiny (6 nodes), so no perf concern.
  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick as (e: unknown, n: unknown) => void}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        elementsSelectable
        panOnScroll
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap pannable zoomable className="!bg-background" />
      </ReactFlow>
    </ReactFlowProvider>
  );
}

function DagLegend({
  partitionSet,
  onRefresh,
  nodeCount,
  edgeCount,
  selectedCell,
}: {
  partitionSet: string;
  onRefresh: () => void;
  nodeCount: number;
  edgeCount: number;
  selectedCell: CellSummary | null;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b pb-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span className="font-semibold tracking-tight">Asset graph</span>
        <span className="text-xs text-muted-foreground">
          {nodeCount} assets · {edgeCount} deps · partitions: {partitionSet}
        </span>
      </div>
      <div className="flex items-center gap-3">
        {selectedCell ? (
          <span className="font-mono text-xs text-muted-foreground">
            {selectedCell.id} · {selectedCell.status}
          </span>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">
            no cell selected
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
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
      <p className="text-sm text-muted-foreground">
        This study has no cells materialized yet.
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Cpu className="h-3.5 w-3.5" />
        <span>Cells — click to load that cell&apos;s materializations</span>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {curve.cells.map((cell) => (
          <button
            key={cell.id}
            type="button"
            onClick={() => onSelect(cell.id)}
            className={cn(
              'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border bg-background px-2.5 py-1.5 text-left transition-colors',
              activeCellId === cell.id
                ? 'border-foreground'
                : 'border-border hover:border-foreground/40',
            )}
          >
            <CellStatusGlyph status={cell.status} />
            <div className="min-w-0">
              <div className="truncate font-mono text-xs">{cell.id}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
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

function StatusIcon({ status }: { status: StageStatus }) {
  const cls = 'h-3 w-3 shrink-0';
  if (status === 'complete')
    return <CheckCircle2 className={cn(cls, 'text-green-500')} />;
  if (status === 'running')
    return <Clock className={cn(cls, 'animate-pulse text-blue-500')} />;
  if (status === 'error')
    return <AlertCircle className={cn(cls, 'text-orange-500')} />;
  return <Circle className={cn(cls, 'text-muted-foreground/60')} />;
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
  if (status === 'complete') return 'border-green-500/40';
  if (status === 'running') return 'border-blue-500/40';
  if (status === 'error') return 'border-orange-500/40';
  return 'border-muted-foreground/30';
}

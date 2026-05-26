'use client';

/**
 * Workbench Universe pane.
 *
 * 2-D heatmap of multiverse cells × spec-curve clusters. Each cell is
 * coloured by per-row robustness (green = agree, yellow = weaker,
 * orange = flips, slate = missing). The y-axis is the spec-curve row
 * representative; the x-axis is the cell (axes:value tuple). Click a
 * heatmap cell to open the cell detail sheet.
 *
 * This is the pane that makes the "we ran your question across the
 * universe of defensible specs" pitch tangible — every column is a
 * specification, every row is a candidate recommendation, every glyph
 * is one cell's vote.
 */

import { useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  type CellRowStatus,
  type CellSummary,
  type SpecCurve,
  type SpecCurveRow,
} from './types';
import {
  CellDetailSheet,
  type CellDetailContext,
} from './cell-detail-sheet';

export function PaneUniverse({
  curve,
  loading,
  cellId,
  onSelectCell,
}: {
  curve: SpecCurve | null;
  loading: boolean;
  cellId: string | null;
  onSelectCell: (cellId: string) => void;
}) {
  const [detailCtx, setDetailCtx] = useState<CellDetailContext | null>(null);

  if (loading || !curve) {
    return (
      <div className="py-6 text-sm text-muted-foreground">
        {loading ? 'Loading multiverse…' : 'Pick a study to see its universe.'}
      </div>
    );
  }

  const avgRobustness =
    curve.rows.length === 0
      ? 0
      : curve.rows.reduce((acc, r) => acc + r.robustness, 0) /
        curve.rows.length;

  return (
    <div className="grid gap-4" data-testid="pane-universe">
      <UniverseStats
        cellCount={curve.cells.length}
        clusterCount={curve.rows.length}
        avgRobustness={avgRobustness}
        falsifierStatus={curve.falsifier_status}
      />
      <UniverseLegend />
      <HeatmapGrid
        curve={curve}
        activeCellId={cellId}
        onSelectCell={(cell) => {
          onSelectCell(cell.id);
          setDetailCtx({ cell, rows: curve.rows });
        }}
      />
      <CellDetailSheet
        ctx={detailCtx}
        onClose={() => setDetailCtx(null)}
      />
    </div>
  );
}

function UniverseStats({
  cellCount,
  clusterCount,
  avgRobustness,
  falsifierStatus,
}: {
  cellCount: number;
  clusterCount: number;
  avgRobustness: number;
  falsifierStatus: SpecCurve['falsifier_status'];
}) {
  const tone =
    falsifierStatus === 'fully_triggered'
      ? 'text-orange-500'
      : falsifierStatus === 'not_triggered'
        ? 'text-green-600 dark:text-green-400'
        : 'text-muted-foreground';
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
      <Stat label="cells" value={String(cellCount)} />
      <Stat label="clusters" value={String(clusterCount)} />
      <Stat
        label="avg robustness"
        value={`${Math.round(avgRobustness * 100)}%`}
      />
      <Stat
        label="falsifier"
        value={falsifierStatus.replace(/_/g, ' ')}
        valueClassName={tone}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={cn('font-semibold tabular-nums', valueClassName)}>
        {value}
      </span>
    </div>
  );
}

function UniverseLegend() {
  const items: Array<{ status: CellRowStatus; label: string; cls: string }> = [
    { status: 'agree', label: 'agree', cls: 'bg-green-500/80' },
    { status: 'weaker', label: 'weaker', cls: 'bg-yellow-500/80' },
    { status: 'flips', label: 'flips', cls: 'bg-orange-500/80' },
    { status: 'missing', label: 'missing', cls: 'bg-muted-foreground/30' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      {items.map((it) => (
        <div key={it.status} className="flex items-center gap-1.5">
          <span className={cn('inline-block h-3 w-3 rounded-[2px]', it.cls)} />
          <span>{it.label}</span>
        </div>
      ))}
      <span className="ml-auto inline-flex items-center gap-1 font-mono">
        rows sorted by robustness <ArrowRight className="h-3 w-3" />
      </span>
    </div>
  );
}

function HeatmapGrid({
  curve,
  activeCellId,
  onSelectCell,
}: {
  curve: SpecCurve;
  activeCellId: string | null;
  onSelectCell: (cell: CellSummary) => void;
}) {
  const cells = curve.cells;
  const rows = useMemo(() => curve.rows.slice(0, 24), [curve.rows]);

  if (cells.length === 0) {
    return (
      <div className="border bg-muted/20 p-4 text-[11px] text-muted-foreground">
        No cells in this study.
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="border bg-muted/20 p-4 text-[11px] text-muted-foreground">
        Spec curve hasn&apos;t produced clustered recommendations yet.
        Either no cells are complete or no recommendation-shaped
        sentences were found in the briefs.
      </div>
    );
  }

  // Sticky grid template — first column is the recommendation, rest are cells.
  const colTemplate = `minmax(220px, 320px) repeat(${cells.length}, minmax(72px, 1fr))`;

  return (
    <div className="overflow-x-auto border bg-background">
      <div className="grid min-w-full" style={{ gridTemplateColumns: colTemplate }}>
        {/* Header row */}
        <div className="sticky left-0 z-10 border-b border-r bg-background px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Recommendation cluster
        </div>
        {cells.map((cell) => (
          <button
            key={cell.id}
            type="button"
            onClick={() => onSelectCell(cell)}
            className={cn(
              'border-b border-r px-2 py-2 text-left text-[10px] transition-colors hover:bg-muted/40',
              activeCellId === cell.id && 'bg-foreground/5',
            )}
            title={cell.id}
          >
            <div className="grid gap-0.5">
              {Object.entries(cell.axes).map(([axis, val]) => (
                <div key={axis} className="flex items-center gap-1">
                  <span className="font-mono text-[9px] uppercase text-muted-foreground">
                    {axis}
                  </span>
                  <span className="truncate font-mono text-[10px]">{val}</span>
                </div>
              ))}
              <div className="mt-1 font-mono text-[9px] text-muted-foreground">
                {cell.status}
                {cell.n_recommendations
                  ? ` · ${cell.n_recommendations} recs`
                  : ''}
              </div>
            </div>
          </button>
        ))}

        {/* Body rows */}
        {rows.map((row) => (
          <RowGroup
            key={row.cluster_id}
            row={row}
            cells={cells}
            activeCellId={activeCellId}
            onSelectCell={onSelectCell}
          />
        ))}
      </div>
      {curve.rows.length > rows.length ? (
        <div className="border-t bg-muted/10 px-3 py-1.5 text-[10px] text-muted-foreground">
          Showing top {rows.length} of {curve.rows.length} clusters by
          robustness; open the Spec curve pane for the full table.
        </div>
      ) : null}
    </div>
  );
}

function RowGroup({
  row,
  cells,
  activeCellId,
  onSelectCell,
}: {
  row: SpecCurveRow;
  cells: CellSummary[];
  activeCellId: string | null;
  onSelectCell: (cell: CellSummary) => void;
}) {
  const robustnessPct = Math.round(row.robustness * 100);
  return (
    <>
      <div
        className="sticky left-0 z-10 border-b border-r bg-background px-3 py-2 text-[11px]"
        title={row.representative}
      >
        <div className="line-clamp-2 leading-snug">{row.representative}</div>
        <div className="mt-1 flex items-center gap-2 font-mono text-[9px] text-muted-foreground">
          <span>cluster {row.cluster_id}</span>
          <RobustnessChip pct={robustnessPct} />
        </div>
      </div>
      {cells.map((cell) => {
        const status = row.statuses[cell.id] ?? 'missing';
        return (
          <button
            key={`${row.cluster_id}-${cell.id}`}
            type="button"
            onClick={() => onSelectCell(cell)}
            title={`${cell.id} — ${status}`}
            className={cn(
              'group relative border-b border-r p-0 transition-transform hover:z-20 hover:scale-[1.08]',
              activeCellId === cell.id && 'ring-2 ring-foreground/40',
            )}
          >
            <div
              className={cn(
                'h-full min-h-[42px] w-full',
                statusFill(status),
              )}
            />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-background opacity-0 group-hover:opacity-90">
              {glyph(status)}
            </span>
          </button>
        );
      })}
    </>
  );
}

function RobustnessChip({ pct }: { pct: number }) {
  const tone =
    pct >= 70
      ? 'border-green-500/60 text-green-500'
      : pct >= 40
        ? 'border-yellow-500/60 text-yellow-500'
        : 'border-orange-500/60 text-orange-500';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[9px]',
        tone,
      )}
    >
      {pct}% robust
    </span>
  );
}

function statusFill(status: CellRowStatus): string {
  switch (status) {
    case 'agree':
      return 'bg-green-500/80';
    case 'weaker':
      return 'bg-yellow-500/80';
    case 'flips':
      return 'bg-orange-500/80';
    default:
      return 'bg-muted-foreground/15';
  }
}

function glyph(status: CellRowStatus): string {
  switch (status) {
    case 'agree':
      return '✓';
    case 'weaker':
      return '~';
    case 'flips':
      return '✗';
    default:
      return '·';
  }
}

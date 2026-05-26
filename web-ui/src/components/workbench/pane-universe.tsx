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
import { PaneCard, PaneDeck, PaneEmpty, PaneGrid } from './pane-layout';
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
      <PaneEmpty>
        {loading ? 'Loading multiverse…' : 'Pick a study to see its universe.'}
      </PaneEmpty>
    );
  }

  const avgRobustness =
    curve.rows.length === 0
      ? 0
      : curve.rows.reduce((acc, r) => acc + r.robustness, 0) /
        curve.rows.length;

  return (
    <PaneDeck data-testid="pane-universe">
      <PaneGrid className="xl:grid-cols-3">
        <PaneCard
          title="Universe"
          meta={`${curve.cells.length} cells · ${curve.rows.length} clusters`}
          className="xl:col-span-2"
        >
          <UniverseStats
            cellCount={curve.cells.length}
            clusterCount={curve.rows.length}
            avgRobustness={avgRobustness}
            falsifierStatus={curve.falsifier_status}
          />
        </PaneCard>
        <PaneCard title="Personas" meta="Derived from cell axes">
          <PersonasSummary cells={curve.cells} />
        </PaneCard>
      </PaneGrid>

      <PaneCard title="Universe / cell list" meta="Click a cell to inspect details">
        <CellList
          cells={curve.cells}
          activeCellId={cellId}
          onSelectCell={onSelectCell}
        />
      </PaneCard>

      <PaneCard
        title="Compare heatmap"
        meta="Rows: recommendation clusters · Columns: cells"
      >
        <UniverseLegend />
        <HeatmapGrid
          curve={curve}
          activeCellId={cellId}
          onSelectCell={(cell) => {
            onSelectCell(cell.id);
            setDetailCtx({ cell, rows: curve.rows });
          }}
        />
      </PaneCard>
      <CellDetailSheet
        ctx={detailCtx}
        onClose={() => setDetailCtx(null)}
      />
    </PaneDeck>
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
      <PaneEmpty className="text-[11px]">No cells in this study.</PaneEmpty>
    );
  }
  if (rows.length === 0) {
    return (
      <PaneEmpty className="text-[11px]">
        Spec curve hasn&apos;t produced clustered recommendations yet.
        Either no cells are complete or no recommendation-shaped
        sentences were found in the briefs.
      </PaneEmpty>
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

function CellList({
  cells,
  activeCellId,
  onSelectCell,
}: {
  cells: CellSummary[];
  activeCellId: string | null;
  onSelectCell: (cellId: string) => void;
}) {
  if (cells.length === 0) {
    return <PaneEmpty>No cells available yet.</PaneEmpty>;
  }
  return (
    <div className="grid max-h-[220px] gap-1 overflow-y-auto pr-1">
      {cells.map((cell) => (
        <button
          key={cell.id}
          type="button"
          onClick={() => onSelectCell(cell.id)}
          className={cn(
            'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded border px-2 py-1.5 text-left text-[11px]',
            activeCellId === cell.id
              ? 'border-foreground bg-foreground/5'
              : 'border-border hover:border-foreground/40',
          )}
        >
          <div className="min-w-0">
            <div className="truncate font-mono">{cell.id}</div>
            <div className="truncate font-mono text-[10px] text-muted-foreground">
              {Object.entries(cell.axes)
                .map(([k, v]) => `${k}:${v}`)
                .join(' · ')}
            </div>
          </div>
          <span className="font-mono text-[10px] text-muted-foreground">
            {cell.status}
          </span>
        </button>
      ))}
    </div>
  );
}

function PersonasSummary({ cells }: { cells: CellSummary[] }) {
  const personaEntries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const cell of cells) {
      for (const [axis, value] of Object.entries(cell.axes)) {
        if (!/persona|audience|stakeholder/i.test(axis)) continue;
        const key = `${axis}=${value}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [cells]);

  if (personaEntries.length === 0) {
    return (
      <PaneEmpty className="text-xs">
        No explicit persona axis in this study&apos;s cell definitions.
      </PaneEmpty>
    );
  }
  return (
    <div className="grid gap-1">
      {personaEntries.slice(0, 8).map(([key, count]) => (
        <div
          key={key}
          className="flex items-center justify-between rounded border px-2 py-1 text-[11px]"
        >
          <span className="truncate font-mono">{key}</span>
          <span className="font-mono text-muted-foreground">{count}</span>
        </div>
      ))}
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

'use client';

/**
 * Workbench Universe pane.
 *
 * Reshaped for non-technical readers: the headline is a clean grid of
 * cells, each rendered as a card with axis chips, status, and a small
 * "evidence" indicator (recommendations + cluster agreement). A short
 * legend up top explains what an axis is. Selecting a card opens the
 * side detail sheet (assumptions, status, brief snippet, lineage
 * shortcut). The compare heatmap is preserved underneath as the
 * power-user view.
 */

import { useMemo, useState } from 'react';
import { ArrowRight, Telescope } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  type CellRowStatus,
  type CellSummary,
  type SpecCurve,
  type SpecCurveRow,
} from './types';
import { PaneCard, PaneDeck, PaneEmpty } from './pane-layout';
import {
  CellDetailSheet,
  type CellDetailContext,
} from './cell-detail-sheet';

const AXIS_HINTS: Record<string, string> = {
  taxonomy: 'How the question is framed (e.g. demand-space vs CoLab).',
  cohort: 'Audience slice the cell weights its evidence toward.',
  window: 'Time period the cell privileges in its evidence.',
};

export function PaneUniverse({
  curve,
  loading,
  cellId,
  onSelectCell,
  onOpenInLineage,
}: {
  curve: SpecCurve | null;
  loading: boolean;
  cellId: string | null;
  onSelectCell: (cellId: string) => void;
  onOpenInLineage?: (cellId: string) => void;
}) {
  const [detailCtx, setDetailCtx] = useState<CellDetailContext | null>(null);

  const axisNames = useMemo(
    () => (curve ? collectAxisNames(curve.cells) : []),
    [curve],
  );
  const evidenceByCell = useMemo(
    () => (curve ? evidenceIndex(curve.cells, curve.rows) : new Map<string, CellEvidence>()),
    [curve],
  );

  if (loading || !curve) {
    return (
      <PaneEmpty>
        {loading ? 'Loading multiverse…' : 'Pick a study to see its universe.'}
      </PaneEmpty>
    );
  }

  const openCellSheet = (cell: CellSummary) => {
    onSelectCell(cell.id);
    setDetailCtx({ cell, rows: curve.rows });
  };

  return (
    <PaneDeck data-testid="pane-universe">
      <ExplainerCard cellCount={curve.cells.length} axisNames={axisNames} />

      <PaneCard
        title="Cells"
        meta={`${curve.cells.length} cells · ${axisNames.length} ${axisNames.length === 1 ? 'axis' : 'axes'}`}
        description="One card = one cell = one defensible specification of the question. Click a card to inspect its assumptions and brief."
      >
        <CellGrid
          cells={curve.cells}
          activeCellId={cellId}
          evidence={evidenceByCell}
          onSelect={openCellSheet}
        />
      </PaneCard>

      <PaneCard
        title="Compare heatmap"
        meta="Power-user view"
        description="Rows are recommendation clusters, columns are cells. Each glyph is one cell's vote on that recommendation."
      >
        <UniverseLegend />
        <HeatmapGrid
          curve={curve}
          activeCellId={cellId}
          onSelectCell={openCellSheet}
        />
      </PaneCard>

      <CellDetailSheet
        ctx={detailCtx}
        onClose={() => setDetailCtx(null)}
        onOpenInLineage={onOpenInLineage}
      />
    </PaneDeck>
  );
}

// ─── Explainer ─────────────────────────────────────────────────────

function ExplainerCard({
  cellCount,
  axisNames,
}: {
  cellCount: number;
  axisNames: string[];
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 shadow-sm shadow-slate-950/[0.04]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-lg bg-blue-50 text-blue-700">
            <Telescope className="h-3.5 w-3.5" />
          </span>
          <h3 className="text-sm font-semibold tracking-tight text-slate-900">
            What you&apos;re looking at
          </h3>
        </div>
        <p className="max-w-3xl text-[12px] leading-snug text-slate-600">
          Each <strong>cell</strong> is a different defensible specification
          of the same question — same study, different framing, cohort, or
          time window. {cellCount} cells means we ran the question{' '}
          {cellCount} ways in parallel. Cards below show the framing on
          each cell and the evidence it produced.
        </p>
      </div>
      {axisNames.length > 0 ? (
        <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {axisNames.map((axis) => (
            <div
              key={axis}
              className="grid gap-0.5 rounded-lg border border-slate-200 bg-slate-50/70 px-2.5 py-1.5"
            >
              <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {axis}
              </span>
              <span className="text-[11px] leading-snug text-slate-600">
                {AXIS_HINTS[axis] ?? 'Choice that varies between cells.'}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ─── Cell grid ─────────────────────────────────────────────────────

type CellEvidence = {
  agree: number;
  weaker: number;
  flips: number;
  participation: number;
};

function CellGrid({
  cells,
  activeCellId,
  evidence,
  onSelect,
}: {
  cells: CellSummary[];
  activeCellId: string | null;
  evidence: Map<string, CellEvidence>;
  onSelect: (cell: CellSummary) => void;
}) {
  if (cells.length === 0) {
    return <PaneEmpty>No cells in this study yet.</PaneEmpty>;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {cells.map((cell) => (
        <CellCard
          key={cell.id}
          cell={cell}
          active={activeCellId === cell.id}
          evidence={evidence.get(cell.id)}
          onSelect={() => onSelect(cell)}
        />
      ))}
    </div>
  );
}

function CellCard({
  cell,
  active,
  evidence,
  onSelect,
}: {
  cell: CellSummary;
  active: boolean;
  evidence: CellEvidence | undefined;
  onSelect: () => void;
}) {
  const axesEntries = Object.entries(cell.axes);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'group grid gap-2.5 rounded-2xl border bg-white px-3 py-3 text-left shadow-sm transition-all',
        active
          ? 'border-slate-950 ring-2 ring-slate-950/15'
          : 'border-slate-200 hover:-translate-y-0.5 hover:border-slate-400',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <CellStatusBadge status={cell.status} />
        <span className="font-mono text-[10px] text-slate-400">
          {cell.elapsed_s != null ? `${cell.elapsed_s.toFixed(0)}s` : '—'}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {axesEntries.map(([axis, value]) => (
          <span
            key={axis}
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px]"
            title={`${axis} = ${value}`}
          >
            <span className="font-mono text-[9px] uppercase tracking-wider text-slate-500">
              {axis}
            </span>
            <span className="font-mono text-[11px] text-slate-800">
              {value}
            </span>
          </span>
        ))}
      </div>
      <EvidenceIndicator
        recommendations={cell.n_recommendations}
        evidence={evidence}
        error={cell.error}
      />
      <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
        <span className="font-mono">{cell.id}</span>
        <span className="inline-flex items-center gap-1 text-slate-400 transition-colors group-hover:text-slate-700">
          inspect <ArrowRight className="h-3 w-3" />
        </span>
      </div>
    </button>
  );
}

function EvidenceIndicator({
  recommendations,
  evidence,
  error,
}: {
  recommendations: number;
  evidence: CellEvidence | undefined;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="rounded-lg border border-orange-200 bg-orange-50 px-2 py-1.5 text-[11px] text-orange-700">
        Cell errored — see detail.
      </div>
    );
  }
  const total = evidence
    ? evidence.agree + evidence.weaker + evidence.flips
    : 0;
  const agreePct = total > 0 ? Math.round((evidence!.agree / total) * 100) : 0;
  return (
    <div className="grid gap-1 rounded-lg border border-slate-100 bg-slate-50/80 px-2 py-1.5">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-slate-500">Evidence</span>
        <span className="font-mono text-[10px] text-slate-700">
          {recommendations} recs
          {total > 0 ? ` · ${agreePct}% agree` : ''}
        </span>
      </div>
      <EvidenceBar evidence={evidence} />
    </div>
  );
}

function EvidenceBar({ evidence }: { evidence: CellEvidence | undefined }) {
  const total = evidence
    ? evidence.agree + evidence.weaker + evidence.flips
    : 0;
  if (!evidence || total === 0) {
    return (
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div className="h-full bg-slate-300/40" style={{ width: '6%' }} />
      </div>
    );
  }
  const agree = (evidence.agree / total) * 100;
  const weaker = (evidence.weaker / total) * 100;
  const flips = (evidence.flips / total) * 100;
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
      <span style={{ width: `${agree}%` }} className="bg-emerald-500/90" />
      <span style={{ width: `${weaker}%` }} className="bg-yellow-400/90" />
      <span style={{ width: `${flips}%` }} className="bg-orange-500/90" />
    </div>
  );
}

function CellStatusBadge({ status }: { status: CellSummary['status'] }) {
  const tone =
    status === 'complete'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : status === 'running'
        ? 'border-blue-200 bg-blue-50 text-blue-700'
        : status === 'error'
          ? 'border-orange-200 bg-orange-50 text-orange-700'
          : 'border-slate-200 bg-slate-100 text-slate-600';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider shadow-sm',
        tone,
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          status === 'complete' && 'bg-emerald-500',
          status === 'running' && 'animate-pulse bg-blue-500',
          status === 'error' && 'bg-orange-500',
          status === 'pending' && 'bg-slate-400',
        )}
      />
      {status}
    </span>
  );
}

// ─── Compare heatmap (preserved) ───────────────────────────────────

function UniverseLegend() {
  const items: Array<{ status: CellRowStatus; label: string; cls: string }> = [
    { status: 'agree', label: 'agree', cls: 'bg-emerald-500/80' },
    { status: 'weaker', label: 'weaker', cls: 'bg-yellow-400/80' },
    { status: 'flips', label: 'flips', cls: 'bg-orange-500/80' },
    { status: 'missing', label: 'missing', cls: 'bg-slate-300/70' },
  ];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-500">
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

  const colTemplate = `minmax(220px, 320px) repeat(${cells.length}, minmax(72px, 1fr))`;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <div className="grid min-w-full" style={{ gridTemplateColumns: colTemplate }}>
          <div className="sticky left-0 z-10 border-b border-r border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Recommendation cluster
          </div>
          {cells.map((cell) => (
            <button
              key={cell.id}
              type="button"
              onClick={() => onSelectCell(cell)}
              className={cn(
                'border-b border-r border-slate-200 bg-slate-50/70 px-2 py-2 text-left text-[10px] transition-colors hover:bg-white',
                activeCellId === cell.id && 'bg-blue-50',
              )}
              title={cell.id}
            >
              <div className="grid gap-0.5">
                {Object.entries(cell.axes).map(([axis, val]) => (
                  <div key={axis} className="flex items-center gap-1">
                    <span className="font-mono text-[9px] uppercase text-slate-500">
                      {axis}
                    </span>
                    <span className="truncate font-mono text-[10px]">{val}</span>
                  </div>
                ))}
                <div className="mt-1 font-mono text-[9px] text-slate-500">
                  {cell.status}
                  {cell.n_recommendations
                    ? ` · ${cell.n_recommendations} recs`
                    : ''}
                </div>
              </div>
            </button>
          ))}

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
      </div>
      {curve.rows.length > rows.length ? (
        <div className="border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-[10px] text-slate-500">
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
        className="sticky left-0 z-10 border-b border-r border-slate-200 bg-white px-3 py-2 text-[11px]"
        title={row.representative}
      >
        <div className="line-clamp-2 leading-snug">{row.representative}</div>
        <div className="mt-1 flex items-center gap-2 font-mono text-[9px] text-slate-500">
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
              'group relative border-b border-r border-slate-200 p-0 transition-transform hover:z-20 hover:scale-[1.08]',
              activeCellId === cell.id && 'ring-2 ring-slate-950/40',
            )}
          >
            <div
              className={cn(
                'h-full min-h-[42px] w-full',
                statusFill(status),
              )}
            />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-white opacity-0 group-hover:opacity-90">
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
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : pct >= 40
        ? 'border-yellow-200 bg-yellow-50 text-yellow-700'
        : 'border-orange-200 bg-orange-50 text-orange-700';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px]',
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
      return 'bg-emerald-500/80';
    case 'weaker':
      return 'bg-yellow-400/80';
    case 'flips':
      return 'bg-orange-500/80';
    default:
      return 'bg-slate-200/80';
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

// ─── Helpers ───────────────────────────────────────────────────────

function collectAxisNames(cells: CellSummary[]): string[] {
  const seen = new Set<string>();
  for (const cell of cells) {
    for (const k of Object.keys(cell.axes ?? {})) seen.add(k);
  }
  return [...seen].sort();
}

function evidenceIndex(
  cells: CellSummary[],
  rows: SpecCurveRow[],
): Map<string, CellEvidence> {
  const map = new Map<string, CellEvidence>();
  for (const cell of cells) {
    map.set(cell.id, { agree: 0, weaker: 0, flips: 0, participation: 0 });
  }
  for (const row of rows) {
    for (const cell of cells) {
      const status = row.statuses[cell.id];
      const ev = map.get(cell.id);
      if (!ev || !status || status === 'missing') continue;
      ev.participation += 1;
      if (status === 'agree') ev.agree += 1;
      if (status === 'weaker') ev.weaker += 1;
      if (status === 'flips') ev.flips += 1;
    }
  }
  return map;
}

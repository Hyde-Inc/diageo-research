'use client';

/**
 * Workbench Spec curve + Cost pane.
 *
 * Top half:
 *   Clustered recommendations table. One row per cluster, sorted by
 *   robustness desc. Per-cell status chips (agree/weaker/flips/missing)
 *   so the operator can see exactly which specifications support each
 *   recommendation.
 *
 * Bottom half:
 *   Per-cell cost histogram. Bars are coloured by cap-awareness:
 *     green if cost ≤ 0.7 × max_cost_usd
 *     yellow if cost > 0.7 × max
 *     orange if cost ≥ max (cap hit)
 *     muted if max not set
 *   Uses recharts (already in the FE), Tailwind for the cap-band
 *   colours.
 */

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  XCircle,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  Cell as RCell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  type CellRowStatus,
  type CellSummary,
  type SpecCurve,
  type StudyCost,
} from './types';
import { PaneCard, PaneDeck, PaneEmpty, PaneGrid } from './pane-layout';
import {
  CellDetailSheet,
  type CellDetailContext,
} from './cell-detail-sheet';

export function PaneSpecCurve({
  curve,
  cost,
  loading,
  costLoading,
  cellId,
  onSelectCell,
}: {
  curve: SpecCurve | null;
  cost: StudyCost | null;
  loading: boolean;
  costLoading: boolean;
  cellId: string | null;
  onSelectCell: (cellId: string) => void;
}) {
  const [detailCtx, setDetailCtx] = useState<CellDetailContext | null>(null);

  if (loading || !curve) {
    return (
      <PaneEmpty>
        {loading ? 'Loading spec curve…' : 'Pick a study to see its spec curve.'}
      </PaneEmpty>
    );
  }

  const diagnostics = summarizeDiagnostics(curve, cost);

  return (
    <PaneDeck data-testid="pane-spec-curve">
      <PaneGrid className="xl:grid-cols-3">
        <PaneCard
          title="Brief"
          meta={`Lead ${(diagnostics.leadRobustness * 100).toFixed(0)}% robust`}
          className="xl:col-span-2"
        >
          <LeadSummary curve={curve} />
        </PaneCard>
        <PaneCard
          title="Tools / diagnostics"
          meta={`${diagnostics.complete} complete · ${diagnostics.error} error`}
          description="Quick run-health snapshot from curve and cost rollups."
        >
          <DiagnosticsSummary diagnostics={diagnostics} />
        </PaneCard>
      </PaneGrid>

      <PaneCard
        title="Compare / sensitivity / spec curve"
        meta={`${curve.rows.length} clusters · ${curve.n_complete}/${curve.n_cells} cells complete`}
      >
        <ClustersTable
          curve={curve}
          activeCellId={cellId}
          onSelectCell={(cell) => {
            onSelectCell(cell.id);
            setDetailCtx({ cell, rows: curve.rows });
          }}
        />
      </PaneCard>

      <PaneCard
        title="Cost"
        meta={
          cost
            ? `total $${cost.total_cost_usd.toFixed(4)} · ${cost.total_calls} calls`
            : costLoading
              ? 'loading…'
              : 'no cost data'
        }
      >
        <CostHistogram
          curve={curve}
          cost={cost}
          onSelectCell={(cell) => {
            onSelectCell(cell.id);
            setDetailCtx({ cell, rows: curve.rows });
          }}
        />
      </PaneCard>

      <CellDetailSheet ctx={detailCtx} onClose={() => setDetailCtx(null)} />
    </PaneDeck>
  );
}

function LeadSummary({ curve }: { curve: SpecCurve }) {
  const leadRow = curve.rows[0];
  if (!leadRow) {
    return <PaneEmpty>No clustered recommendations yet.</PaneEmpty>;
  }
  const total =
    leadRow.n_agree + leadRow.n_weaker + leadRow.n_flips + leadRow.n_missing;
  const pct = Math.round(leadRow.robustness * 100);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono uppercase tracking-wide">Lead recommendation</span>
        <span className="font-semibold tabular-nums text-foreground">
          {pct}% robust
        </span>
        <span>
          {leadRow.n_agree}/{total} cells agree
        </span>
      </div>
      <p className="max-w-4xl text-sm leading-relaxed text-foreground">
        {leadRow.representative}
      </p>
      {leadRow.fragile_specs.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {leadRow.fragile_specs.slice(0, 4).map((spec) => (
            <Badge
              key={spec}
              variant="outline"
              className="font-mono text-[10px] text-orange-500"
            >
              fragile: {spec}
            </Badge>
          ))}
        </div>
      ) : null}
      {curve.falsifier_notes.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">
            Falsifier notes ({curve.falsifier_status.replace(/_/g, ' ')}) —{' '}
            {curve.falsifier_notes.length}
          </summary>
          <ul className="mt-1 list-disc pl-5 leading-snug">
            {curve.falsifier_notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ClustersTable({
  curve,
  activeCellId,
  onSelectCell,
}: {
  curve: SpecCurve;
  activeCellId: string | null;
  onSelectCell: (cell: CellSummary) => void;
}) {
  const cellsById = useMemo(() => {
    const m = new Map<string, CellSummary>();
    for (const c of curve.cells) m.set(c.id, c);
    return m;
  }, [curve.cells]);

  if (curve.rows.length === 0) {
    return (
      <PaneEmpty className="text-[11px]">
        No clustered recommendations to show yet.
      </PaneEmpty>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-[11px]">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="border-r border-slate-200 px-2 py-2 text-left font-semibold">#</th>
            <th className="border-r border-slate-200 px-2 py-2 text-left font-semibold">
              Recommendation
            </th>
            <th className="border-r border-slate-200 px-2 py-2 text-left font-semibold">
              Robustness
            </th>
            {curve.cells.map((c) => (
              <th
                key={c.id}
                className="border-r border-slate-200 px-1.5 py-2 text-center font-mono normal-case"
                title={c.id}
              >
                <div className="grid gap-0">
                  {Object.values(c.axes).slice(0, 2).map((v, i) => (
                    <span key={i} className="truncate">
                      {v}
                    </span>
                  ))}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {curve.rows.map((row, idx) => (
            <tr
              key={row.cluster_id}
              className={cn(
                'align-top',
                idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/60',
              )}
            >
              <td className="border-r border-slate-200 px-2 py-2 text-center font-mono text-[10px] text-slate-500">
                {idx + 1}
              </td>
              <td className="border-r border-slate-200 px-2 py-2">
                <div className="line-clamp-3 leading-snug">
                  {row.representative}
                </div>
              </td>
              <td className="border-r border-slate-200 px-2 py-2">
                <RobustnessBar
                  pct={Math.round(row.robustness * 100)}
                  agree={row.n_agree}
                  total={
                    row.n_agree + row.n_weaker + row.n_flips + row.n_missing
                  }
                />
              </td>
              {curve.cells.map((c) => {
                const status = row.statuses[c.id] ?? 'missing';
                const cell = cellsById.get(c.id);
                return (
                  <td
                    key={c.id}
                    className={cn(
                      'border-r border-slate-200 px-1.5 py-2 text-center',
                      activeCellId === c.id && 'bg-blue-50',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => cell && onSelectCell(cell)}
                      title={`${c.id} — ${status}`}
                      className="grid place-items-center"
                    >
                      <StatusGlyph status={status} />
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function RobustnessBar({
  pct,
  agree,
  total,
}: {
  pct: number;
  agree: number;
  total: number;
}) {
  const tone =
    pct >= 70
      ? 'bg-green-500'
      : pct >= 40
        ? 'bg-yellow-500'
        : 'bg-orange-500';
  return (
    <div className="grid w-[112px] gap-0.5">
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className={cn('absolute left-0 top-0 h-full rounded-full', tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="font-mono text-[9px] text-muted-foreground">
        {pct}% ({agree}/{total})
      </div>
    </div>
  );
}

function StatusGlyph({ status }: { status: CellRowStatus }) {
  const cls = 'h-3.5 w-3.5';
  if (status === 'agree')
    return <CheckCircle2 className={cn(cls, 'text-green-500')} />;
  if (status === 'weaker')
    return <CircleDashed className={cn(cls, 'text-yellow-500')} />;
  if (status === 'flips')
    return <XCircle className={cn(cls, 'text-orange-500')} />;
  return <span className="text-muted-foreground">·</span>;
}

// ─── Cost histogram ────────────────────────────────────────────────

type CostBar = {
  cell_id: string;
  short: string;
  cost_usd: number;
  max_cost_usd: number | null;
  ratio: number | null;
  n_calls: number;
};

function CostHistogram({
  curve,
  cost,
  onSelectCell,
}: {
  curve: SpecCurve;
  cost: StudyCost | null;
  onSelectCell: (cell: CellSummary) => void;
}) {
  const cellsById = useMemo(() => {
    const m = new Map<string, CellSummary>();
    for (const c of curve.cells) m.set(c.id, c);
    return m;
  }, [curve.cells]);

  const bars: CostBar[] = useMemo(() => {
    if (!cost) return [];
    return cost.cells.map((c) => ({
      cell_id: c.cell_id,
      short: shortCellLabel(c.cell_id),
      cost_usd: c.cost_usd ?? 0,
      max_cost_usd: c.max_cost_usd,
      ratio:
        c.max_cost_usd != null && c.max_cost_usd > 0
          ? (c.cost_usd ?? 0) / c.max_cost_usd
          : null,
      n_calls: c.n_calls ?? 0,
    }));
  }, [cost]);

  const totalsAllZero =
    bars.length > 0 && bars.every((b) => b.cost_usd === 0);

  return (
    <div className="grid gap-2">
      {bars.length === 0 ? (
        <PaneEmpty>No cost rollup yet for this study.</PaneEmpty>
      ) : (
        <div
          className="h-[260px] w-full"
          style={{ minHeight: 260, minWidth: 320 }}
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={320} minHeight={240}>
            <BarChart
              data={bars}
              margin={{ top: 8, right: 8, bottom: 24, left: 8 }}
            >
              <XAxis
                dataKey="short"
                stroke="#64748b"
                tick={{ fontSize: 10, fontFamily: 'ui-monospace' }}
                angle={-12}
                textAnchor="end"
                height={36}
                interval={0}
              />
              <YAxis
                stroke="#64748b"
                tick={{ fontSize: 10 }}
                tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
                width={56}
              />
              <Tooltip
                cursor={{ fill: 'rgba(100, 116, 139, 0.08)' }}
                contentStyle={{
                  background: '#ffffff',
                  border: '1px solid #e2e8f0',
                  fontSize: 11,
                  fontFamily: 'ui-monospace',
                  borderRadius: 12,
                  boxShadow: '0 10px 24px rgba(15, 23, 42, 0.08)',
                }}
                labelStyle={{ color: '#0f172a' }}
                formatter={(value: unknown, _name, payload) => {
                  const b = payload?.payload as CostBar | undefined;
                  if (!b) return [String(value), 'cost'];
                  const cap =
                    b.max_cost_usd != null
                      ? ` / cap $${b.max_cost_usd.toFixed(4)}`
                      : '';
                  return [
                    `$${b.cost_usd.toFixed(4)}${cap}`,
                    `cost (${b.n_calls} calls)`,
                  ];
                }}
                labelFormatter={(label) => {
                  const b = bars.find((x) => x.short === label);
                  return b ? b.cell_id : String(label);
                }}
              />
              <Bar
                dataKey="cost_usd"
              >
                {bars.map((b) => (
                  <RCell
                    key={b.cell_id}
                    fill={barColour(b.ratio)}
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      const cell = cellsById.get(b.cell_id);
                      if (cell) onSelectCell(cell);
                    }}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {totalsAllZero ? (
        <div className="flex items-start gap-2 border-l-2 border-yellow-500/60 bg-yellow-500/5 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 text-yellow-500" />
          <span>
            Every cell reports $0.00. Either no cell has finished a paid
            stage yet, or the runner is using a mocked client. The
            cost.json files live at{' '}
            <code className="font-mono">runs/&lt;run_id&gt;/cost.json</code>.
          </span>
        </div>
      ) : null}
      <CapLegend />
    </div>
  );
}

type DiagnosticsSummaryData = {
  complete: number;
  running: number;
  pending: number;
  error: number;
  leadRobustness: number;
  fragileSpecs: number;
  zeroCostCells: number;
  totalCells: number;
  falsifierStatus: SpecCurve['falsifier_status'];
};

function summarizeDiagnostics(
  curve: SpecCurve,
  cost: StudyCost | null,
): DiagnosticsSummaryData {
  const byStatus = curve.cells.reduce(
    (acc, cell) => {
      acc[cell.status] += 1;
      return acc;
    },
    { complete: 0, running: 0, pending: 0, error: 0 },
  );
  const lead = curve.rows[0];
  const zeroCostCells = cost?.cells.filter((c) => (c.cost_usd ?? 0) === 0).length ?? 0;
  return {
    ...byStatus,
    leadRobustness: lead?.robustness ?? 0,
    fragileSpecs: lead?.fragile_specs.length ?? 0,
    zeroCostCells,
    totalCells: curve.cells.length,
    falsifierStatus: curve.falsifier_status,
  };
}

function DiagnosticsSummary({
  diagnostics,
}: {
  diagnostics: DiagnosticsSummaryData;
}) {
  return (
    <div className="grid gap-2 text-xs">
      <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
        <Metric label="complete" value={String(diagnostics.complete)} />
        <Metric label="running" value={String(diagnostics.running)} />
        <Metric label="pending" value={String(diagnostics.pending)} />
        <Metric label="error" value={String(diagnostics.error)} />
      </div>
      <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-2 text-slate-500">
        <p>falsifier: {diagnostics.falsifierStatus.replace(/_/g, ' ')}</p>
        <p>fragile specs in lead: {diagnostics.fragileSpecs}</p>
        <p>
          zero-cost cells: {diagnostics.zeroCostCells}/{diagnostics.totalCells}
        </p>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-2 py-1.5 shadow-sm">
      <div className="uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-base font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function CapLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      <LegendSwatch colour="#22c55e" label="≤ 70% of cap" />
      <LegendSwatch colour="#eab308" label="70 – 100%" />
      <LegendSwatch colour="#f97316" label="cap hit" />
      <LegendSwatch colour="#94a3b8" label="no cap declared" />
    </div>
  );
}

function LegendSwatch({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-3 w-3 rounded-[2px]"
        style={{ background: colour }}
      />
      {label}
    </span>
  );
}

function barColour(ratio: number | null): string {
  if (ratio == null) return '#94a3b8';
  if (ratio >= 1) return '#f97316';
  if (ratio >= 0.7) return '#eab308';
  return '#22c55e';
}

function shortCellLabel(id: string): string {
  // cell ids are axis-joined with double underscores; keep at most 18 chars
  if (id.length <= 18) return id;
  return id.slice(0, 16) + '…';
}

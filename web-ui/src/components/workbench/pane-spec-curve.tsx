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
import {
  type CellRowStatus,
  type CellSummary,
  type SpecCurve,
  type StudyCost,
} from './types';
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
      <div className="py-6 text-sm text-muted-foreground">
        {loading ? 'Loading spec curve…' : 'Pick a study to see its spec curve.'}
      </div>
    );
  }

  return (
    <div className="grid gap-6" data-testid="pane-spec-curve">
      <LeadSummary curve={curve} />

      <SubSection
        title="Clustered recommendations"
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
      </SubSection>

      <SubSection
        title="Per-cell cost · cap-aware"
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
          loading={costLoading}
          onSelectCell={(cell) => {
            onSelectCell(cell.id);
            setDetailCtx({ cell, rows: curve.rows });
          }}
        />
      </SubSection>

      <CellDetailSheet ctx={detailCtx} onClose={() => setDetailCtx(null)} />
    </div>
  );
}

function LeadSummary({ curve }: { curve: SpecCurve }) {
  const leadRow = curve.rows[0];
  if (!leadRow) {
    return (
      <p className="text-sm text-muted-foreground">
        No clustered recommendations yet. The curve is rebuilt on every
        request — wait for cells to write their final.md.
      </p>
    );
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
      <p className="max-w-4xl text-base leading-relaxed text-foreground">
        {leadRow.representative}
      </p>
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

function SubSection({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-2">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-2">
        <h3 className="text-base font-semibold tracking-tight">{title}</h3>
        {meta ? (
          <span className="text-xs text-muted-foreground">{meta}</span>
        ) : null}
      </header>
      {children}
    </section>
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
      <div className="border bg-muted/20 p-3 text-[11px] text-muted-foreground">
        No clustered recommendations to show yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border bg-background">
      <table className="min-w-full border-collapse text-[11px]">
        <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="border-r px-2 py-1.5 text-left font-semibold">#</th>
            <th className="border-r px-2 py-1.5 text-left font-semibold">
              Recommendation
            </th>
            <th className="border-r px-2 py-1.5 text-left font-semibold">
              Robustness
            </th>
            {curve.cells.map((c) => (
              <th
                key={c.id}
                className="border-r px-1.5 py-1.5 text-center font-mono normal-case"
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
                idx % 2 === 0 ? 'bg-background' : 'bg-muted/10',
              )}
            >
              <td className="border-r px-2 py-1.5 text-center font-mono text-[10px] text-muted-foreground">
                {idx + 1}
              </td>
              <td className="border-r px-2 py-1.5">
                <div className="line-clamp-3 leading-snug">
                  {row.representative}
                </div>
              </td>
              <td className="border-r px-2 py-1.5">
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
                      'border-r px-1.5 py-1.5 text-center',
                      activeCellId === c.id && 'bg-foreground/5',
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
      <div className="relative h-1.5 w-full overflow-hidden bg-muted">
        <div
          className={cn('absolute left-0 top-0 h-full', tone)}
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
  loading,
  onSelectCell,
}: {
  curve: SpecCurve;
  cost: StudyCost | null;
  loading: boolean;
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
        <div className="text-sm text-muted-foreground">
          No cost rollup yet for this study.
        </div>
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
                stroke="hsl(var(--muted-foreground))"
                tick={{ fontSize: 10, fontFamily: 'ui-monospace' }}
                angle={-12}
                textAnchor="end"
                height={36}
                interval={0}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                tick={{ fontSize: 10 }}
                tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
                width={56}
              />
              <Tooltip
                cursor={{ fill: 'hsl(var(--muted-foreground) / 0.08)' }}
                contentStyle={{
                  background: 'hsl(var(--background))',
                  border: '1px solid hsl(var(--border))',
                  fontSize: 11,
                  fontFamily: 'ui-monospace',
                }}
                labelStyle={{ color: 'hsl(var(--foreground))' }}
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
                onClick={(_data: unknown, _idx, evt) => {
                  // recharts forwards the original payload at evt.payload? Not reliably;
                  // we look up by the bar payload available via internal hooks
                }}
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

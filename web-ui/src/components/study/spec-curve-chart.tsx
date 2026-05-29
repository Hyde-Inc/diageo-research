'use client';

/**
 * Robustness curve — the two-panel "specification curve" visualisation
 * popularised by Simonsohn, Simmons & Nelson (2020).
 *
 * Internally we still call it a spec curve. The visible copy avoids
 * jargon: "Robustness curve" / "Sensitivity view" / "scenarios".
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ TOP     scenarios on x, score on y (bars + zero line)   │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ BOTTOM  rows = dimensions, cols = same scenarios        │
 *   │         coloured chips show which value is active       │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Each scenario column is a clickable target; selecting a column
 * surfaces its assumptions, the chosen recommendation's status, and an
 * "Open scenario" link in the side panel rendered next to the chart.
 *
 * The chart is rendered with plain SVG (no chart library) so we keep
 * full keyboard + aria control and avoid the recharts axis flicker that
 * shows up on small canvases. Colours match the rest of the focused
 * pages: emerald = holds, amber = weakens, orange = flips, slate =
 * missing.
 */

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { humaniseValue } from '@/components/evidence/claim-utils';
import type {
  CellRowStatus,
  CellSummary,
  SpecCurveRow,
} from '@/components/workbench/types';

export type ScenarioStatus = CellRowStatus;

export type ScenarioDatum = {
  cellId: string;
  cell: CellSummary;
  status: ScenarioStatus;
  score: number; // +1 agree · 0 weaker · -1 flips · NaN missing
  effectLabel: string; // 'holds' | 'weakens' | 'flips' | 'no read'
};

export type DimensionFilter = {
  dimension: string;
  hiddenValues: string[];
};

const STATUS_SCORE: Record<ScenarioStatus, number> = {
  agree: 1,
  weaker: 0,
  flips: -1,
  missing: Number.NaN,
};

const STATUS_LABEL: Record<ScenarioStatus, string> = {
  agree: 'holds',
  weaker: 'weakens',
  flips: 'flips',
  missing: 'no read',
};

const STATUS_COLOR: Record<ScenarioStatus, string> = {
  agree: '#10b981',
  weaker: '#f59e0b',
  flips: '#f97316',
  missing: '#cbd5e1',
};

const STATUS_FILL: Record<ScenarioStatus, string> = {
  agree: 'bg-emerald-500',
  weaker: 'bg-amber-500',
  flips: 'bg-orange-500',
  missing: 'bg-slate-300',
};

/**
 * Stable per-(dimension, value) colour ramp. Same dimension keeps the
 * same hue across rows so the matrix is scannable even when values
 * change between scenarios.
 */
const PALETTE = [
  '#0ea5e9', // sky-500
  '#a855f7', // purple-500
  '#14b8a6', // teal-500
  '#ef4444', // rose-500
  '#facc15', // yellow-400
  '#6366f1', // indigo-500
  '#ec4899', // pink-500
  '#84cc16', // lime-500
];

export function buildScenarios(
  row: SpecCurveRow | null,
  cells: CellSummary[],
): ScenarioDatum[] {
  if (!row) return [];
  return cells.map((cell) => {
    const status = (row.statuses[cell.id] ?? 'missing') as ScenarioStatus;
    return {
      cellId: cell.id,
      cell,
      status,
      score: STATUS_SCORE[status],
      effectLabel: STATUS_LABEL[status],
    };
  });
}

export function sortScenarios(
  scenarios: ScenarioDatum[],
  mode: SortMode,
  agreementByCell: Map<string, number>,
): ScenarioDatum[] {
  const copy = [...scenarios];
  switch (mode) {
    case 'effect':
      copy.sort((a, b) => scoreForSort(b.score) - scoreForSort(a.score));
      return copy;
    case 'agreement':
      copy.sort(
        (a, b) =>
          (agreementByCell.get(b.cellId) ?? 0) -
          (agreementByCell.get(a.cellId) ?? 0),
      );
      return copy;
    case 'index':
    default:
      return copy;
  }
}

export type SortMode = 'effect' | 'agreement' | 'index';

function scoreForSort(score: number): number {
  return Number.isNaN(score) ? -2 : score;
}

export type SpecCurveChartProps = {
  scenarios: ScenarioDatum[];
  dimensions: string[];
  selectedCellId: string | null;
  onSelectCell: (cellId: string | null) => void;
  ariaLabel?: string;
};

export function SpecCurveChart({
  scenarios,
  dimensions,
  selectedCellId,
  onSelectCell,
  ariaLabel = 'Robustness curve',
}: SpecCurveChartProps) {
  // Per-dimension stable value→colour map.
  const dimensionColors = useMemo(
    () => buildDimensionPalette(dimensions, scenarios),
    [dimensions, scenarios],
  );

  // Sizing — we draw with viewBox so the SVG scales fluidly.
  const colCount = Math.max(scenarios.length, 1);
  const colWidth = 56; // px in viewBox units
  const chartHeight = 160;
  const matrixRowHeight = 26;
  const matrixHeight = dimensions.length * matrixRowHeight + 16;
  const leftGutter = 84; // labels for dimensions on left of matrix
  const rightPad = 12;
  const topPad = 16;
  const xZero = leftGutter;
  const innerW = colCount * colWidth;
  const totalW = leftGutter + innerW + rightPad;
  const totalH = topPad + chartHeight + matrixHeight + 36;

  // Y axis range: always -1 to 1 for clarity (status maps to ±1/0).
  const yScale = (score: number) => {
    const v = Number.isNaN(score) ? 0 : Math.max(-1, Math.min(1, score));
    const half = chartHeight / 2;
    return topPad + half - v * (half - 6);
  };
  const yBaseline = topPad + chartHeight / 2;

  if (scenarios.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 p-6 text-center text-sm text-slate-500">
        No scenarios to plot for the selected recommendation.
      </div>
    );
  }

  return (
    <div className="w-full overflow-x-auto" data-testid="spec-curve-chart">
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${totalW} ${totalH}`}
        className="block h-auto min-w-full"
        style={{ width: Math.max(totalW, 480) }}
      >
        {/* Three verdict lanes: Holds (top) · Weakens (mid) · Flips (bottom).
            The verdict is categorical, so we plot one marker per framing in
            its lane rather than faking a magnitude bar. */}
        {(
          [
            { score: 1, label: 'Holds' },
            { score: 0, label: 'Weakens' },
            { score: -1, label: 'Flips' },
          ] as const
        ).map((lane) => (
          <g key={lane.label}>
            <line
              x1={xZero}
              x2={xZero + innerW}
              y1={yScale(lane.score)}
              y2={yScale(lane.score)}
              stroke={lane.score === 0 ? '#cbd5e1' : '#eef2f7'}
              strokeDasharray={lane.score === 0 ? undefined : '2 5'}
            />
            <text
              x={xZero - 10}
              y={yScale(lane.score) + 3}
              textAnchor="end"
              fontSize="10"
              fontWeight={600}
              fill="#475569"
            >
              {lane.label}
            </text>
          </g>
        ))}

        {/* Persistent highlight bands behind the framings that do NOT hold,
            spanning chart + matrix so the verdict reads straight down to the
            analytic choices that produced it. */}
        {scenarios.map((s, i) => {
          if (s.status !== 'weaker' && s.status !== 'flips') return null;
          const isFlip = s.status === 'flips';
          return (
            <rect
              key={`band-${s.cellId}`}
              x={xZero + i * colWidth + 3}
              y={topPad - 6}
              width={colWidth - 6}
              height={chartHeight + matrixHeight + 10}
              fill={isFlip ? '#fee2e2' : '#fef3c7'}
              opacity={0.6}
              rx={8}
            />
          );
        })}

        {/* One marker per framing, placed in its verdict lane. Shape AND
            lane carry the meaning (circle = holds, diamond = weakens,
            triangle = flips, hollow = no read) so it reads without relying
            on colour alone. */}
        {scenarios.map((s, i) => {
          const cx = xZero + i * colWidth + colWidth / 2;
          const isSelected = selectedCellId === s.cellId;
          const isMissing = s.status === 'missing';
          const markerY = yScale(isMissing ? 0 : s.score);
          const color = STATUS_COLOR[s.status];
          const ariaLabel = isMissing
            ? `Framing ${i + 1}: no read on the lead recommendation`
            : s.status === 'flips'
              ? `Framing ${i + 1}: flips the lead recommendation (fragile)`
              : s.status === 'weaker'
                ? `Framing ${i + 1}: weakens the lead recommendation (fragile)`
                : `Framing ${i + 1}: holds the lead recommendation`;
          return (
            <g
              key={s.cellId}
              role="button"
              tabIndex={0}
              aria-label={ariaLabel}
              data-fragile={
                s.status === 'weaker' || s.status === 'flips' ? s.status : undefined
              }
              onClick={() => onSelectCell(isSelected ? null : s.cellId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectCell(isSelected ? null : s.cellId);
                }
              }}
              style={{ cursor: 'pointer' }}
            >
              {/* selection / hit target */}
              <rect
                x={cx - colWidth / 2 + 2}
                y={topPad}
                width={colWidth - 4}
                height={chartHeight + matrixHeight}
                fill={isSelected ? '#0f172a' : 'transparent'}
                opacity={isSelected ? 0.06 : 1}
                rx={6}
              />
              {/* stem from the neutral line to the marker */}
              <line
                x1={cx}
                x2={cx}
                y1={yBaseline}
                y2={markerY}
                stroke={color}
                strokeWidth={2}
                opacity={0.35}
              />
              {isMissing ? (
                <circle
                  cx={cx}
                  cy={markerY}
                  r={6}
                  fill="white"
                  stroke="#94a3b8"
                  strokeWidth={1.5}
                  opacity={0.7}
                />
              ) : s.status === 'agree' ? (
                <circle cx={cx} cy={markerY} r={7.5} fill={color} stroke="white" strokeWidth={1.5} />
              ) : s.status === 'weaker' ? (
                <polygon
                  points={`${cx},${markerY - 8} ${cx + 8},${markerY} ${cx},${markerY + 8} ${cx - 8},${markerY}`}
                  fill={color}
                  stroke="white"
                  strokeWidth={1.5}
                />
              ) : (
                <polygon
                  points={`${cx - 8},${markerY - 7} ${cx + 8},${markerY - 7} ${cx},${markerY + 8}`}
                  fill={color}
                  stroke="white"
                  strokeWidth={1.5}
                />
              )}
              {/* column index label */}
              <text
                x={cx}
                y={topPad + chartHeight + 14}
                textAnchor="middle"
                fontSize="9"
                fill={isSelected ? '#0f172a' : '#64748b'}
                fontWeight={isSelected ? 700 : 500}
              >
                {i + 1}
              </text>
            </g>
          );
        })}

        {/* Divider between panels */}
        <line
          x1={0}
          x2={totalW}
          y1={topPad + chartHeight + 22}
          y2={topPad + chartHeight + 22}
          stroke="#e2e8f0"
        />

        {/* Bottom panel: dimensions × scenarios matrix */}
        {dimensions.map((dim, r) => {
          const yRow = topPad + chartHeight + 32 + r * matrixRowHeight;
          return (
            <g key={dim}>
              <text
                x={xZero - 8}
                y={yRow + matrixRowHeight / 2 + 3}
                textAnchor="end"
                fontSize="10"
                fontWeight={500}
                fill="#334155"
              >
                {humaniseDim(dim)}
              </text>
              {scenarios.map((s, i) => {
                const cx = xZero + i * colWidth + colWidth / 2;
                const value = s.cell.axes[dim] ?? '';
                const color = value
                  ? (dimensionColors.get(dim)?.get(value) ?? '#94a3b8')
                  : '#e2e8f0';
                const isSelected = selectedCellId === s.cellId;
                return (
                  <g key={s.cellId + dim}>
                    <rect
                      x={cx - colWidth / 2 + 3}
                      y={yRow + 3}
                      width={colWidth - 6}
                      height={matrixRowHeight - 6}
                      fill={color}
                      opacity={value ? (isSelected ? 0.95 : 0.85) : 0.25}
                      rx={4}
                    />
                    <text
                      x={cx}
                      y={yRow + matrixRowHeight / 2 + 3}
                      textAnchor="middle"
                      fontSize="9"
                      fill="#0f172a"
                    >
                      {abbrev(value)}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function buildDimensionPalette(
  dimensions: string[],
  scenarios: ScenarioDatum[],
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const dim of dimensions) {
    const seen: string[] = [];
    for (const s of scenarios) {
      const v = s.cell.axes[dim];
      if (v && !seen.includes(v)) seen.push(v);
    }
    const valueMap = new Map<string, string>();
    seen.forEach((v, i) => {
      valueMap.set(v, PALETTE[i % PALETTE.length]);
    });
    out.set(dim, valueMap);
  }
  return out;
}

function humaniseDim(d: string): string {
  return d.replace(/_/g, ' ');
}

function abbrev(raw: string): string {
  if (!raw) return '·';
  const value = humaniseValue(raw);
  if (value.length <= 13) return value;
  return value.slice(0, 12) + '…';
}

export function ChartLegend({ className }: { className?: string }) {
  const items: Array<{ status: ScenarioStatus; copy: string }> = [
    { status: 'agree', copy: 'Holds — the recommendation survives this framing' },
    { status: 'weaker', copy: 'Weakens (fragile) — softens or hedges' },
    { status: 'flips', copy: 'Flips (fragile) — the framing reverses it' },
    { status: 'missing', copy: 'No read — no directive from this framing yet' },
  ];
  return (
    <ul
      className={cn(
        'flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600',
        className,
      )}
    >
      {items.map((item) => (
        <li key={item.status} className="inline-flex items-center gap-1.5">
          <LegendSwatch status={item.status} />
          <span>{item.copy}</span>
        </li>
      ))}
    </ul>
  );
}

function LegendSwatch({ status }: { status: ScenarioStatus }) {
  // Mirror the chart markers: circle = holds, diamond = weakens,
  // triangle = flips, hollow circle = no read.
  const color = STATUS_COLOR[status];
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="shrink-0">
      {status === 'agree' ? (
        <circle cx="7" cy="7" r="5" fill={color} />
      ) : status === 'weaker' ? (
        <polygon points="7,1.5 12.5,7 7,12.5 1.5,7" fill={color} />
      ) : status === 'flips' ? (
        <polygon points="1.5,3 12.5,3 7,12.5" fill={color} />
      ) : (
        <circle cx="7" cy="7" r="5" fill="none" stroke="#94a3b8" strokeWidth="1.5" />
      )}
    </svg>
  );
}

export const STATUS_META = {
  STATUS_COLOR,
  STATUS_FILL,
  STATUS_LABEL,
  STATUS_SCORE,
};

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
  const yTop = topPad;
  const yBottom = topPad + chartHeight;

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
        {/* Top panel: gridlines + zero baseline */}
        <line
          x1={xZero}
          x2={xZero + innerW}
          y1={yTop}
          y2={yTop}
          stroke="#e2e8f0"
          strokeDasharray="2 4"
        />
        <line
          x1={xZero}
          x2={xZero + innerW}
          y1={yBottom}
          y2={yBottom}
          stroke="#e2e8f0"
          strokeDasharray="2 4"
        />
        <line
          x1={xZero}
          x2={xZero + innerW}
          y1={yBaseline}
          y2={yBaseline}
          stroke="#94a3b8"
        />
        <text
          x={xZero - 8}
          y={yTop + 4}
          textAnchor="end"
          fontSize="9"
          fill="#475569"
        >
          holds
        </text>
        <text
          x={xZero - 8}
          y={yBaseline + 3}
          textAnchor="end"
          fontSize="9"
          fill="#475569"
        >
          neutral
        </text>
        <text
          x={xZero - 8}
          y={yBottom + 4}
          textAnchor="end"
          fontSize="9"
          fill="#475569"
        >
          flips
        </text>

        {/*
          Fragile-bar fill patterns. The hatch/dot patterns ride on top
          of the base STATUS_COLOR fill for flips / weakens so the bar
          is visibly different from the holds bars even when a viewer
          can't rely on hue alone (colour-blind safety, projector glare,
          monochrome printouts). The patterns scope by status so screen
          readers still get the verbal effect from the aria-label.
        */}
        <defs>
          <pattern
            id="fragile-flips-hatch"
            patternUnits="userSpaceOnUse"
            width="6"
            height="6"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" fill={STATUS_COLOR.flips} />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#7c2d12" strokeWidth="1.6" />
          </pattern>
          <pattern
            id="fragile-weaker-dot"
            patternUnits="userSpaceOnUse"
            width="5"
            height="5"
          >
            <rect width="5" height="5" fill={STATUS_COLOR.weaker} />
            <circle cx="2.5" cy="2.5" r="1.1" fill="#92400e" />
          </pattern>
        </defs>

        {/* Bars */}
        {scenarios.map((s, i) => {
          const cx = xZero + i * colWidth + colWidth / 2;
          const colorFill = STATUS_COLOR[s.status];
          const fragileFill =
            s.status === 'flips'
              ? 'url(#fragile-flips-hatch)'
              : s.status === 'weaker'
                ? 'url(#fragile-weaker-dot)'
                : colorFill;
          const isFragile = s.status === 'flips' || s.status === 'weaker';
          const isSelected = selectedCellId === s.cellId;
          const isMissing = Number.isNaN(s.score);
          // Weakens lands on the zero baseline so a pure score-driven
          // bar would be invisible. Force a visible chip when fragile
          // so the highlight reads in the top chart, not just in the
          // dimension matrix below (FR-RB-3).
          const fragileMinHeight = s.status === 'weaker' ? 18 : 6;
          const top = isMissing ? yBaseline - 1 : yScale(s.score);
          const bottom = yBaseline;
          const y = Math.min(top, bottom);
          const rawHeight = Math.abs(top - bottom);
          const height = Math.max(
            rawHeight,
            isMissing ? 2 : isFragile ? fragileMinHeight : 4,
          );
          // Push weaker chips slightly above the baseline so they
          // visually sit alongside the holds bars instead of vanishing
          // into the axis line.
          const yAdjusted =
            s.status === 'weaker' && rawHeight < fragileMinHeight
              ? yBaseline - fragileMinHeight / 2
              : y;
          const ariaLabel = isMissing
            ? `Scenario ${i + 1}: no read on the lead recommendation`
            : s.status === 'flips'
              ? `Scenario ${i + 1}: flips the lead recommendation (fragile)`
              : s.status === 'weaker'
                ? `Scenario ${i + 1}: weakens the lead recommendation (fragile)`
                : `Scenario ${i + 1}: holds the lead recommendation`;
          return (
            <g
              key={s.cellId}
              role="button"
              tabIndex={0}
              aria-label={ariaLabel}
              data-fragile={isFragile ? s.status : undefined}
              onClick={() => onSelectCell(isSelected ? null : s.cellId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectCell(isSelected ? null : s.cellId);
                }
              }}
              style={{ cursor: 'pointer' }}
            >
              {/* invisible hit target */}
              <rect
                x={cx - colWidth / 2 + 2}
                y={topPad}
                width={colWidth - 4}
                height={chartHeight + matrixHeight}
                fill={isSelected ? '#f1f5f9' : 'transparent'}
                rx={6}
              />
              <rect
                x={cx - 8}
                y={yAdjusted}
                width={16}
                height={height}
                fill={fragileFill}
                stroke={isFragile ? '#0f172a' : 'none'}
                strokeWidth={isFragile ? 1.25 : 0}
                opacity={isMissing ? 0.45 : 1}
                rx={2}
              />
              {/* Fragile glyph above the bar — small triangle for
                  flips, small caret for weakens. Pure SVG so we keep
                  the no-new-deps rule. */}
              {s.status === 'flips' ? (
                <polygon
                  points={`${cx - 4},${yAdjusted - 4} ${cx + 4},${yAdjusted - 4} ${cx},${yAdjusted - 10}`}
                  fill="#9a3412"
                  aria-hidden="true"
                />
              ) : s.status === 'weaker' ? (
                <polyline
                  points={`${cx - 4},${yAdjusted - 4} ${cx},${yAdjusted - 9} ${cx + 4},${yAdjusted - 4}`}
                  fill="none"
                  stroke="#92400e"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                />
              ) : null}
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

function abbrev(value: string): string {
  if (!value) return '·';
  if (value.length <= 11) return value;
  return value.slice(0, 10) + '…';
}

export function ChartLegend({ className }: { className?: string }) {
  const items: Array<{
    status: ScenarioStatus;
    copy: string;
    pattern?: 'flips' | 'weaker';
  }> = [
    { status: 'agree', copy: 'holds — the recommendation survives this framing' },
    {
      status: 'weaker',
      copy: 'weakens (fragile) — recommendation softens or hedges',
      pattern: 'weaker',
    },
    {
      status: 'flips',
      copy: 'flips (fragile) — the framing reverses the recommendation',
      pattern: 'flips',
    },
    { status: 'missing', copy: 'no read — scenario has not produced a directive yet' },
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
          <LegendSwatch status={item.status} pattern={item.pattern} />
          <span>{item.copy}</span>
        </li>
      ))}
    </ul>
  );
}

function LegendSwatch({
  status,
  pattern,
}: {
  status: ScenarioStatus;
  pattern?: 'flips' | 'weaker';
}) {
  if (!pattern) {
    return (
      <span
        className={cn('h-2.5 w-2.5 rounded-sm', STATUS_FILL[status])}
        aria-hidden="true"
      />
    );
  }
  // Inline pattern preview so the legend matches the chart's hatched
  // / dotted fragile bars without us reaching for an extra <defs>.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
      className="shrink-0"
    >
      <defs>
        <pattern
          id={`legend-${pattern}`}
          patternUnits="userSpaceOnUse"
          width={pattern === 'flips' ? 6 : 5}
          height={pattern === 'flips' ? 6 : 5}
          patternTransform={pattern === 'flips' ? 'rotate(45)' : undefined}
        >
          <rect
            width={pattern === 'flips' ? 6 : 5}
            height={pattern === 'flips' ? 6 : 5}
            fill={STATUS_COLOR[status]}
          />
          {pattern === 'flips' ? (
            <line x1="0" y1="0" x2="0" y2="6" stroke="#7c2d12" strokeWidth="1.6" />
          ) : (
            <circle cx="2.5" cy="2.5" r="1.1" fill="#92400e" />
          )}
        </pattern>
      </defs>
      <rect
        x="1"
        y="1"
        width="12"
        height="12"
        rx="2"
        fill={`url(#legend-${pattern})`}
        stroke="#0f172a"
        strokeWidth="0.6"
      />
    </svg>
  );
}

export const STATUS_META = {
  STATUS_COLOR,
  STATUS_FILL,
  STATUS_LABEL,
  STATUS_SCORE,
};

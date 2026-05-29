'use client';

/**
 * Robustness spec-curve data helpers.
 *
 * Internally we still call it a spec curve (Simonsohn, Simmons & Nelson
 * 2020); the visible copy avoids jargon. This module owns only the
 * scenario shaping + sort + status maps — the robustness view itself is
 * rendered as a verdict table in `robustness-panel.tsx`. Status colours:
 * emerald = holds, amber = weakens, red/orange = flips, slate = missing.
 */

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

export const STATUS_META = {
  STATUS_COLOR,
  STATUS_FILL,
  STATUS_LABEL,
  STATUS_SCORE,
};

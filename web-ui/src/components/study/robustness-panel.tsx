'use client';

/**
 * Embeddable robustness / spec-curve panel (used by /research tab and legacy /robustness redirect).
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { ArrowRight, Filter, ListChecks, MessageCircle } from 'lucide-react';
import { FocusCard } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { Badge } from '@/components/ui/badge';
import { humaniseValue } from '@/components/evidence/claim-utils';
import {
  buildScenarios,
  sortScenarios,
  type ScenarioDatum,
  type SortMode,
} from '@/components/study/spec-curve-chart';
import { cn } from '@/lib/utils';
import type { SpecCurve, SpecCurveRow } from '@/components/workbench/types';

const SORT_LABEL: Record<SortMode, string> = {
  effect: 'effect (holds → flips)',
  agreement: 'scenario agreement across all findings',
  index: 'scenario index (original order)',
};

// Verdict styling, keyed off the per-cell spec-curve status. The verdict
// is the answer, so the header cells are solid colour; the choice cells
// below inherit only a faint tint when the setup does NOT hold, so the
// 2 non-holding columns read as a group straight down to their choices.
const VERDICT: Record<
  ScenarioDatum['status'],
  { label: string; cell: string; tint: string; dot: string }
> = {
  agree: { label: 'Holds', cell: 'bg-emerald-500 text-white', tint: '', dot: 'bg-emerald-500' },
  weaker: { label: 'Weakens', cell: 'bg-amber-500 text-white', tint: 'bg-amber-50', dot: 'bg-amber-500' },
  flips: { label: 'Flips', cell: 'bg-red-500 text-white', tint: 'bg-red-50', dot: 'bg-red-500' },
  missing: { label: 'No read', cell: 'bg-slate-200 text-slate-600', tint: 'bg-slate-50', dot: 'bg-slate-300' },
};

export function RobustnessPanel() {
  return (
    <Suspense fallback={null}>
      <RobustnessPanelBody />
    </Suspense>
  );
}

function RobustnessPanelBody() {
  const { curve, loadingCurve, studyId } = useStudyData();
  const search = useSearchParams();
  const recommendationSlug = search.get('recommendation');
  const [activeClusterId, setActiveClusterId] = useState<number | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('effect');
  const [hiddenValues, setHiddenValues] = useState<
    Record<string, Set<string>>
  >({});
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);

  // FR-RB-2: when /growth-driver (or any other surface) jumps here
  // with ?recommendation=<slug>, find the cluster whose representative
  // text slugifies to the same handle and pre-select it. Falls back to
  // the lead cluster when the slug doesn't resolve.
  const slugCluster = useMemo<number | null>(() => {
    if (!recommendationSlug || !curve) return null;
    const target = recommendationSlug.toLowerCase();
    const match = curve.rows.find(
      (row) => slugifyRepresentative(row.representative) === target,
    );
    if (match) return match.cluster_id;
    const fuzzy = curve.rows.find((row) =>
      slugifyRepresentative(row.representative).includes(target),
    );
    return fuzzy?.cluster_id ?? null;
  }, [recommendationSlug, curve]);

  const leadCluster = curve?.rows[0]?.cluster_id ?? null;
  const currentClusterId =
    activeClusterId != null && curve?.rows.some((r) => r.cluster_id === activeClusterId)
      ? activeClusterId
      : (slugCluster ?? leadCluster);
  const currentRow = useMemo<SpecCurveRow | null>(() => {
    if (!curve || currentClusterId == null) return null;
    return curve.rows.find((r) => r.cluster_id === currentClusterId) ?? null;
  }, [curve, currentClusterId]);

  // True when the active cluster came from ?recommendation= and the
  // user hasn't picked something else from the rail — that's the
  // signal to scope the chart to the cluster's own cells (FR-RB-2).
  const scopedToRecommendation =
    activeClusterId == null &&
    slugCluster != null &&
    currentRow?.cluster_id === slugCluster;

  const dimensions = useMemo(() => collectDimensions(curve), [curve]);
  const agreementByCell = useMemo(
    () => agreementIndex(curve, currentRow),
    [curve, currentRow],
  );

  const filteredCells = useMemo(() => {
    if (!curve) return [];
    const memberSet =
      scopedToRecommendation && currentRow
        ? new Set(currentRow.members)
        : null;
    return curve.cells.filter((cell) => {
      if (memberSet && !memberSet.has(cell.id)) return false;
      return dimensions.every(
        (dim) => !hiddenValues[dim]?.has(cell.axes[dim] ?? ''),
      );
    });
  }, [curve, dimensions, hiddenValues, scopedToRecommendation, currentRow]);

  const scenarios = useMemo<ScenarioDatum[]>(() => {
    const all = buildScenarios(currentRow, filteredCells);
    return sortScenarios(all, sortMode, agreementByCell);
  }, [currentRow, filteredCells, sortMode, agreementByCell]);

  const selectedScenario =
    scenarios.find((s) => s.cellId === selectedCellId) ?? null;

  const ready = Boolean(studyId && !loadingCurve && curve && curve.rows.length > 0);

  if (!studyId) return null;

  if (loadingCurve || !curve) {
    return (
      <FocusCard tone="muted">
        <div className="grid gap-3">
          <p className="text-[11px] italic leading-snug text-slate-500">
            Loading the robustness chart…
          </p>
          <div className="h-44 animate-pulse rounded-2xl bg-slate-200/70" />
        </div>
      </FocusCard>
    );
  }

  if (curve.rows.length === 0) {
    return (
      <FocusCard>
        <p className="text-sm text-slate-600">
          No scenarios are ready yet. Check{' '}
          <Link
            href={withStudy('/setup', studyId)}
            className="font-medium text-slate-900 underline-offset-4 hover:underline"
          >
            Setup
          </Link>{' '}
          for run status.
        </p>
      </FocusCard>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_minmax(0,280px)]">
      <div className="grid gap-4">
        {scopedToRecommendation && currentRow ? (
          <FocusCard tone="muted" className="border-dashed">
            <p className="text-[12px] leading-snug text-slate-700">
              Scoped to recommendation{' '}
              <span className="font-semibold text-slate-900">
                {truncateSentence(
                  cleanRepresentative(currentRow.representative),
                  100,
                )}
              </span>
              .
            </p>
          </FocusCard>
        ) : null}
        <ChartCard
          scenarios={scenarios}
          dimensions={dimensions}
          selectedCellId={selectedCellId}
          onSelectCell={setSelectedCellId}
          currentRow={currentRow}
        />
        <DetailPanel
          scenario={selectedScenario}
          studyId={studyId}
          currentRow={currentRow}
          dimensions={dimensions}
          scenarioIndex={
            selectedScenario
              ? scenarios.findIndex(
                  (s) => s.cellId === selectedScenario.cellId,
                ) + 1
              : null
          }
          onClose={() => setSelectedCellId(null)}
        />
        <EdgeStateNotice scenarios={scenarios} />
      </div>
      {ready ? (
        <ControlsRail
          curve={curve}
          currentClusterId={currentClusterId}
          onPickCluster={setActiveClusterId}
          sortMode={sortMode}
          onChangeSort={setSortMode}
          dimensions={dimensions}
          hiddenValues={hiddenValues}
          onToggleValue={(dim, value) =>
            setHiddenValues((prev) => {
              const next = { ...prev };
              const existing = new Set(next[dim] ?? []);
              if (existing.has(value)) existing.delete(value);
              else existing.add(value);
              next[dim] = existing;
              return next;
            })
          }
          onClearFilters={() => setHiddenValues({})}
        />
      ) : null}
    </div>
  );
}

function ControlsRail({
  curve,
  currentClusterId,
  onPickCluster,
  sortMode,
  onChangeSort,
  dimensions,
  hiddenValues,
  onToggleValue,
  onClearFilters,
}: {
  curve: SpecCurve;
  currentClusterId: number | null;
  onPickCluster: (id: number) => void;
  sortMode: SortMode;
  onChangeSort: (mode: SortMode) => void;
  dimensions: string[];
  hiddenValues: Record<string, Set<string>>;
  onToggleValue: (dimension: string, value: string) => void;
  onClearFilters: () => void;
}) {
  const totalHidden = dimensions.reduce(
    (acc, dim) => acc + (hiddenValues[dim]?.size ?? 0),
    0,
  );
  return (
    <FocusCard>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        Controls
      </h3>
      <div className="mt-3 grid gap-3">
        <div className="grid gap-1.5">
          <label
            htmlFor="recommendation-picker"
            className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500"
          >
            Recommendation
          </label>
          <select
            id="recommendation-picker"
            value={currentClusterId ?? ''}
            onChange={(e) => onPickCluster(Number(e.target.value))}
            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 shadow-inner focus-visible:ring-2 focus-visible:ring-slate-200"
          >
            {curve.rows.map((row, idx) => (
              <option key={row.cluster_id} value={row.cluster_id}>
                {idx === 0 ? 'Lead · ' : `Alt #${idx} · `}
                {truncateSentence(cleanRepresentative(row.representative), 80)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <label
            htmlFor="sort-picker"
            className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500"
          >
            Sort scenarios by
          </label>
          <select
            id="sort-picker"
            value={sortMode}
            onChange={(e) => onChangeSort(e.target.value as SortMode)}
            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 shadow-inner focus-visible:ring-2 focus-visible:ring-slate-200"
          >
            {(['effect', 'agreement', 'index'] as SortMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {SORT_LABEL[mode]}
              </option>
            ))}
          </select>
        </div>
        {dimensions.length > 0 ? (
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                <Filter className="h-3 w-3" />
                Dimension filters
              </span>
              {totalHidden > 0 ? (
                <button
                  type="button"
                  onClick={onClearFilters}
                  className="text-[11px] font-medium text-slate-600 underline-offset-4 hover:underline"
                >
                  Reset ({totalHidden})
                </button>
              ) : null}
            </div>
            <p className="text-[11px] leading-snug text-slate-500">
              Click a value to hide that subset from the chart.
            </p>
            <div className="grid gap-2">
              {dimensions.map((dim) => (
                <DimensionFilterRow
                  key={dim}
                  dimension={dim}
                  values={uniqueValues(curve, dim)}
                  hidden={hiddenValues[dim] ?? new Set<string>()}
                  onToggle={(value) => onToggleValue(dim, value)}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </FocusCard>
  );
}

function DimensionFilterRow({
  dimension,
  values,
  hidden,
  onToggle,
}: {
  dimension: string;
  values: string[];
  hidden: Set<string>;
  onToggle: (value: string) => void;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {humaniseDimension(dimension)}
      </span>
      <div className="flex flex-wrap gap-1">
        {values.map((value) => {
          const isHidden = hidden.has(value);
          return (
            <button
              key={value}
              type="button"
              onClick={() => onToggle(value)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium shadow-sm transition-colors',
                isHidden
                  ? 'border-slate-200 bg-white text-slate-400 line-through hover:border-slate-300'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
              )}
              aria-pressed={isHidden}
              title={isHidden ? `Show ${humaniseValue(value)}` : `Hide ${humaniseValue(value)}`}
            >
              {humaniseValue(value)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChartCard({
  scenarios,
  dimensions,
  selectedCellId,
  onSelectCell,
  currentRow,
}: {
  scenarios: ScenarioDatum[];
  dimensions: string[];
  selectedCellId: string | null;
  onSelectCell: (cellId: string | null) => void;
  currentRow: SpecCurveRow | null;
}) {
  const summary = useMemo(() => summarise(scenarios), [scenarios]);
  // Of the setups that do NOT hold, which analytic choices do they all
  // share? That's the load-bearing assumption — the one "where it breaks"
  // line. Derived from the cells, so an all-hold study shows nothing.
  const fragileInsight = useMemo(() => {
    const fragile = scenarios.filter(
      (s) => s.status === 'weaker' || s.status === 'flips',
    );
    if (fragile.length === 0) return null;
    const shared = dimensions
      .map((dim) => {
        const values = new Set(
          fragile.map((s) => s.cell.axes[dim]).filter(Boolean),
        );
        return values.size === 1
          ? { dim, value: Array.from(values)[0] as string }
          : null;
      })
      .filter((x): x is { dim: string; value: string } => x !== null);
    return { count: fragile.length, shared };
  }, [scenarios, dimensions]);
  const hasMissing = scenarios.some((s) => s.status === 'missing');
  return (
    <div data-testid="robustness-verdict-card">
      <FocusCard>
        <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Same question · {scenarios.length} defensible setups — does the
              answer survive?
            </p>
            <h3 className="mt-1 text-sm font-semibold tracking-tight text-slate-950">
              {currentRow
                ? truncateSentence(cleanRepresentative(currentRow.representative), 140)
                : 'Pick a recommendation'}
            </h3>
            {scenarios.length > 0 ? (
              <p className="mt-1 text-[13px] font-medium leading-snug text-slate-800">
                {verdictSentence(summary, scenarios.length)}
              </p>
            ) : (
              <p className="mt-1 text-[12px] leading-snug text-slate-600">
                No scenarios match the current filter.
              </p>
            )}
          </div>
          {currentRow ? (
            <Badge
              variant="outline"
              className="shrink-0 border-slate-200 bg-white text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600"
            >
              Robustness {(currentRow.robustness * 100).toFixed(0)}%
            </Badge>
          ) : null}
        </header>
        {scenarios.length > 0 ? (
          <VerdictTable
            scenarios={scenarios}
            dimensions={dimensions}
            selectedCellId={selectedCellId}
            onSelectCell={onSelectCell}
          />
        ) : null}
        {fragileInsight && fragileInsight.shared.length > 0 ? (
          <p className="mt-3 text-[12px] leading-snug text-slate-700">
            <span className="font-semibold text-amber-700">Where it breaks — </span>
            the {fragileInsight.count} setup
            {fragileInsight.count === 1 ? '' : 's'} that don&apos;t hold all use{' '}
            {fragileInsight.shared.map((t, idx) => (
              <span key={t.dim} className="font-semibold text-slate-900">
                {humaniseValue(t.value)}
                {idx < fragileInsight.shared.length - 1 ? (
                  <span className="font-normal text-slate-500"> + </span>
                ) : null}
              </span>
            ))}
            .
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-600">
          <VerdictKey status="agree" label="Holds — same answer wins" />
          <VerdictKey status="weaker" label="Weakens — same answer, softer" />
          <VerdictKey status="flips" label="Flips — answer reverses" />
          {hasMissing ? <VerdictKey status="missing" label="No read" /> : null}
        </div>
      </FocusCard>
    </div>
  );
}

// The whole robustness view, as one table: columns are the defensible
// setups (sorted holds → flips so the non-holding ones group on the
// right), the top row is the verdict per setup, and the rows beneath are
// the either/or choices that define each setup. No chart, no legend
// paragraph — the colours and labels carry it.
function VerdictTable({
  scenarios,
  dimensions,
  selectedCellId,
  onSelectCell,
}: {
  scenarios: ScenarioDatum[];
  dimensions: string[];
  selectedCellId: string | null;
  onSelectCell: (cellId: string | null) => void;
}) {
  return (
    <div className="overflow-x-auto" data-testid="verdict-table">
      <table className="w-full table-fixed border-separate border-spacing-1">
        <colgroup>
          <col className="w-24 sm:w-28" />
          {scenarios.map((s) => (
            <col key={s.cellId} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th
              scope="col"
              className="px-1 pb-1 text-left align-bottom text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500"
            >
              Verdict
            </th>
            {scenarios.map((s, i) => {
              const v = VERDICT[s.status];
              const isSel = selectedCellId === s.cellId;
              return (
                <th
                  key={s.cellId}
                  scope="col"
                  className={cn(
                    'rounded-lg p-0 align-middle',
                    v.cell,
                    isSel && 'ring-2 ring-slate-900 ring-offset-1',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelectCell(isSel ? null : s.cellId)}
                    aria-pressed={isSel}
                    aria-label={`Setup ${i + 1}: ${v.label}. Show its brief.`}
                    className="flex w-full flex-col items-center gap-0.5 rounded-lg px-1.5 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                  >
                    <span className="text-[9px] font-medium uppercase tracking-wide opacity-80">
                      {i + 1}
                    </span>
                    <span className="text-[13px] font-bold leading-tight">
                      {v.label}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {dimensions.map((dim) => (
            <tr key={dim}>
              <th
                scope="row"
                className="px-1 py-1.5 text-left align-middle text-[10px] font-semibold uppercase tracking-wide text-slate-500"
              >
                {humaniseDimension(dim)}
              </th>
              {scenarios.map((s) => {
                const isSel = selectedCellId === s.cellId;
                const isHold = s.status === 'agree';
                const value = s.cell.axes[dim] ?? '';
                return (
                  <td
                    key={s.cellId + dim}
                    className={cn(
                      'break-words rounded-md border px-1.5 py-1.5 text-center align-middle text-[12px] font-medium leading-tight text-slate-800',
                      isHold
                        ? 'border-slate-200 bg-white'
                        : cn('border-transparent', VERDICT[s.status].tint),
                      isSel && 'ring-1 ring-slate-400',
                    )}
                  >
                    {humaniseValue(value) || '—'}
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

function VerdictKey({
  status,
  label,
}: {
  status: ScenarioDatum['status'];
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('h-3 w-3 rounded-[3px]', VERDICT[status].dot)} />
      <span>{label}</span>
    </span>
  );
}

// One-line verdict that leads the card: how many setups hold. Derived, so
// the live study (all hold) never implies fake fragility. The table and
// the "where it breaks" line carry the detail, so this stays short.
function verdictSentence(
  summary: { holds: number; weakens: number; flips: number; missing: number },
  total: number,
): string {
  const { holds } = summary;
  if (holds === total) {
    return `Holds in all ${total} setups — no defensible setup reverses it.`;
  }
  if (holds / total >= 0.6) {
    return `Holds in ${holds} of ${total} setups.`;
  }
  return `Holds in only ${holds} of ${total} setups — the answer is fragile.`;
}

function DetailPanel({
  scenario,
  studyId,
  currentRow,
  dimensions,
  scenarioIndex,
  onClose,
}: {
  scenario: ScenarioDatum | null;
  studyId: string | null;
  currentRow: SpecCurveRow | null;
  dimensions: string[];
  scenarioIndex: number | null;
  onClose: () => void;
}) {
  if (!scenario || !currentRow) {
    return (
      <FocusCard tone="muted" className="border-dashed">
        <p className="text-[12px] leading-snug text-slate-600">
          Click a setup&apos;s verdict to see that scenario&apos;s assumptions,
          the recommendation&apos;s status for it, and a link to its detail
          page.
        </p>
      </FocusCard>
    );
  }
  return (
    <FocusCard>
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Scenario {scenarioIndex ?? '?'}
          </span>
          <h3 className="mt-1 text-sm font-semibold tracking-tight text-slate-950">
            {humaniseScenarioTitle(scenario)}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] font-medium text-slate-500 underline-offset-4 hover:underline"
          aria-label="Close scenario panel"
        >
          Close
        </button>
      </div>
      <div className="mt-3 grid gap-3">
        <div className="grid gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Recommendation in this scenario
          </span>
          <span
            className={cn(
              'inline-flex w-fit items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold',
              statusToneClass(scenario.status),
            )}
          >
            {effectSentence(scenario)}
          </span>
          <p className="text-[12px] leading-snug text-slate-700">
            {truncateSentence(cleanRepresentative(currentRow.representative), 220)}
          </p>
        </div>
        <div className="grid gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Assumptions in this framing
          </span>
          <ul className="grid gap-1">
            {dimensions.map((dim) => (
              <li
                key={dim}
                className="flex flex-wrap items-baseline gap-1.5 text-[12px] text-slate-700"
              >
                <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  {humaniseDimension(dim)}
                </span>
                <span className="font-medium text-slate-900">
                  {humaniseValue(scenario.cell.axes[dim] ?? '') || '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {studyId ? (
            <Link
              href={withStudy(`/scenario/${currentRow.cluster_id}`, studyId)}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-slate-950 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-slate-800"
            >
              Open scenario
              <ArrowRight className="h-3 w-3" />
            </Link>
          ) : null}
          {studyId ? (
            <Link
              href={withStudy('/ask', studyId, { scenario: scenario.cellId })}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50"
            >
              <MessageCircle className="h-3 w-3" />
              Ask about this framing
            </Link>
          ) : null}
        </div>
      </div>
    </FocusCard>
  );
}

function EdgeStateNotice({ scenarios }: { scenarios: ScenarioDatum[] }) {
  if (scenarios.length === 0) return null;
  if (scenarios.length === 1) {
    return (
      <FocusCard tone="muted" className="border-dashed">
        <p className="text-[12px] leading-snug text-slate-600">
          <ListChecks className="mr-1 inline h-3.5 w-3.5 -translate-y-0.5 text-slate-500" />
          Only one defensible framing has voted so far. Robustness is
          undefined with a single scenario — add a dimension or run more
          framings before treating the answer as robust.
        </p>
      </FocusCard>
    );
  }
  const allSame = scenarios.every((s) => s.status === scenarios[0].status);
  if (allSame) {
    return (
      <FocusCard tone="muted" className="border-dashed">
        <p className="text-[12px] leading-snug text-slate-600">
          Every scenario landed on the same verdict ({scenarios[0].effectLabel}).
          That&apos;s either a strong signal or a sign the dimensions we
          tried are too narrow — add a dimension that could plausibly flip
          the answer to strengthen the test.
        </p>
      </FocusCard>
    );
  }
  return null;
}

function summarise(scenarios: ScenarioDatum[]) {
  let holds = 0;
  let weakens = 0;
  let flips = 0;
  let missing = 0;
  for (const s of scenarios) {
    if (s.status === 'agree') holds += 1;
    else if (s.status === 'weaker') weakens += 1;
    else if (s.status === 'flips') flips += 1;
    else missing += 1;
  }
  return { holds, weakens, flips, missing };
}

function statusToneClass(status: ScenarioDatum['status']): string {
  if (status === 'agree') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (status === 'weaker') return 'border-yellow-200 bg-yellow-50 text-yellow-700';
  if (status === 'flips') return 'border-orange-200 bg-orange-50 text-orange-700';
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

function effectSentence(scenario: ScenarioDatum): string {
  switch (scenario.status) {
    case 'agree':
      return 'Holds in this framing';
    case 'weaker':
      return 'Weakens in this framing';
    case 'flips':
      return 'Flips in this framing';
    case 'missing':
    default:
      return 'No directive from this framing yet';
  }
}

function humaniseScenarioTitle(scenario: ScenarioDatum): string {
  const parts = Object.entries(scenario.cell.axes).map(
    ([dim, value]) => `${humaniseDimension(dim)} · ${humaniseValue(value)}`,
  );
  if (parts.length === 0) return scenario.cellId;
  return parts.join('  /  ');
}

function humaniseDimension(d: string): string {
  return d.replace(/_/g, ' ');
}

function uniqueValues(curve: SpecCurve, dim: string): string[] {
  const seen = new Set<string>();
  for (const cell of curve.cells) {
    const v = cell.axes[dim];
    if (v) seen.add(v);
  }
  return Array.from(seen);
}

function collectDimensions(curve: SpecCurve | null): string[] {
  if (!curve) return [];
  const seen = new Set<string>();
  for (const cell of curve.cells) {
    for (const k of Object.keys(cell.axes)) seen.add(k);
  }
  return Array.from(seen);
}

function agreementIndex(
  curve: SpecCurve | null,
  currentRow: SpecCurveRow | null,
): Map<string, number> {
  if (!curve || !currentRow) return new Map();
  const out = new Map<string, number>();
  for (const cell of curve.cells) {
    let count = 0;
    for (const row of curve.rows) {
      if (row.statuses[cell.id] === 'agree') count += 1;
    }
    out.set(cell.id, count);
  }
  return out;
}

function cleanRepresentative(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  const cutMatch = trimmed.search(/##\s*Pre-?registration|##\s+/i);
  const sliced = cutMatch >= 0 ? trimmed.slice(0, cutMatch) : trimmed;
  return sliced
    .replace(/\*\*/g, '')
    .replace(/_+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Slugify a cluster's representative sentence so /growth-driver-style
 * recommendation slugs (e.g. "crown-peach-tailgate") can match. We
 * intentionally clip to ~10 tokens so the slug stays stable across
 * minor wording edits in the cluster representative.
 */
function slugifyRepresentative(raw: string): string {
  if (!raw) return '';
  return cleanRepresentative(raw)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 10)
    .join('-');
}

function truncateSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 40 ? slice.slice(0, lastSpace) : slice) + '…';
}

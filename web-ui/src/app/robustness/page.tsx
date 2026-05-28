'use client';

/**
 * /robustness — the "Sensitivity view" / Robustness curve.
 *
 * Internally this is a specification curve. The visible copy avoids
 * jargon. Layout follows Simonsohn, Simmons & Nelson (2020):
 *   - TOP panel: one bar per scenario, sorted by the lead
 *     recommendation's effect; bar colour encodes holds / weakens /
 *     flips / no read.
 *   - BOTTOM panel: a small matrix where rows are the dimensions
 *     (taxonomy, cohort, window, …) and columns are the same scenarios
 *     in the same order; cells show which value of the dimension is
 *     active for that scenario.
 *
 * Controls — recommendation selector, sort selector, dimension filters
 * — live in a sticky right rail so the chart owns the central space.
 * The legend stays beneath the chart. Clicking a scenario column
 * opens its scenario panel below the chart.
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { ArrowRight, Filter, ListChecks, MessageCircle } from 'lucide-react';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { Badge } from '@/components/ui/badge';
import {
  ChartLegend,
  SpecCurveChart,
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

export default function RobustnessPage() {
  return (
    <Suspense fallback={null}>
      <RobustnessBody />
    </Suspense>
  );
}

function RobustnessBody() {
  const data = useStudyData();
  const { curve, loadingCurve, studyId, detail } = data;
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
  const question = detail?.question?.trim() || curve?.question?.trim() || '';
  // FR-RB-1: surface the study question as the H1, not the static
  // "Robustness curve" label that regressed in. The eyebrow keeps the
  // page identity ("Sensitivity view") so the section is still findable.
  const heading = question || 'Robustness — sensitivity view';

  return (
    <StudyShell
      data={data}
      eyebrow="Sensitivity view"
      title={heading}
      intro="Each scenario tries the same question with a different defensible framing — the chart shows holds, weakens, and flips per scenario."
      contentClassName="max-w-[1500px]"
      mainLabel="Robustness chart"
      rightLabel="Controls"
      main={
        !studyId ? null : loadingCurve || !curve ? (
          <FocusCard tone="muted">
            <div className="grid gap-3">
              <p className="text-[11px] italic leading-snug text-slate-500">
                Loading the robustness chart…
              </p>
              <div className="h-44 animate-pulse rounded-2xl bg-slate-200/70" />
              <div className="h-24 animate-pulse rounded-2xl bg-slate-200/70" />
            </div>
          </FocusCard>
        ) : curve.rows.length === 0 ? (
          <FocusCard>
            <p className="text-sm text-slate-600">
              No scenarios are ready yet — the briefs have not produced
              recommendation-shaped sentences. Check{' '}
              <Link
                href={withStudy('/setup', studyId)}
                className="font-medium text-slate-900 underline-offset-4 hover:underline"
              >
                Setup
              </Link>{' '}
              for run status.
            </p>
          </FocusCard>
        ) : (
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
                  . Showing only the {currentRow.members.length} scenario
                  {currentRow.members.length === 1 ? '' : 's'} this
                  recommendation appears in. Clear the filter from the rail
                  to see every scenario.
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
        )
      }
      right={
        !ready ? null : (
          <ControlsRail
            curve={curve!}
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
        )
      }
    />
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
              title={isHidden ? `Show ${value}` : `Hide ${value}`}
            >
              {value}
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
  return (
    <FocusCard>
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight text-slate-950">
            {currentRow
              ? truncateSentence(cleanRepresentative(currentRow.representative), 140)
              : 'Pick a recommendation'}
          </h3>
          <p className="mt-1 text-[12px] leading-snug text-slate-600">
            {scenarios.length === 0
              ? 'No scenarios match the current filter.'
              : `${summary.holds} hold · ${summary.weakens} weaken · ${summary.flips} flip${summary.missing > 0 ? ` · ${summary.missing} no read` : ''}.`}
          </p>
        </div>
        {currentRow ? (
          <Badge
            variant="outline"
            className="border-slate-200 bg-white text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600"
          >
            Robustness {(currentRow.robustness * 100).toFixed(0)}%
          </Badge>
        ) : null}
      </header>
      <SpecCurveChart
        scenarios={scenarios}
        dimensions={dimensions}
        selectedCellId={selectedCellId}
        onSelectCell={onSelectCell}
        ariaLabel="Robustness curve: scenarios on x, effect on y, dimensions in the matrix below."
      />
      <div className="mt-3 grid gap-2">
        <ChartLegend />
        <p className="text-[11px] leading-snug text-slate-500">
          “Holds” means the framing supports the recommendation. “Weakens”
          softens or hedges it. “Flips” reverses it. Click a column to see
          its assumptions and open the scenario.
        </p>
      </div>
    </FocusCard>
  );
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
          Click any column to see that scenario&apos;s assumptions, the
          recommendation&apos;s status for it, and a link to its detail
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
                  {scenario.cell.axes[dim] ?? '—'}
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
    ([dim, value]) => `${humaniseDimension(dim)} · ${value}`,
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

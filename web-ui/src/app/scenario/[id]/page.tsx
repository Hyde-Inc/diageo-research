'use client';

/**
 * /scenario/[id] — focused single-scenario view.
 *
 * `id` is the spec-curve cluster_id. The page is intentionally narrow:
 * a plain-language title (the cluster's representative line), the
 * recommendation itself, and the 2–3 numbers that make it defensible
 * (cells agree, cells weaker, cells flip; robustness pct).
 *
 * Two outbound links: another scenario (back to the stoplight grid)
 * and "see evidence" → /evidence/[id] using the same id.
 */

import Link from 'next/link';
import { use, useMemo } from 'react';
import { ArrowRight, Beaker } from 'lucide-react';
import {
  cleanRepresentative,
  describeCellAxes,
  humanizeSpecKey,
} from '@/components/evidence/claim-utils';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { cn } from '@/lib/utils';
import type {
  CellRowStatus,
  CellSummary,
  SpecCurveRow,
} from '@/components/workbench/types';

export default function ScenarioPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const data = useStudyData();
  const { curve, loadingCurve, studyId } = data;

  const row: SpecCurveRow | null = useMemo(() => {
    if (!curve) return null;
    return curve.rows.find((r) => String(r.cluster_id) === id) ?? null;
  }, [curve, id]);

  const cells = useMemo(() => curve?.cells ?? [], [curve]);
  const breakdown = useMemo(() => breakDownByStatus(row, cells), [row, cells]);
  // Resolve this scenario's spec-curve rank so the counter-scenario CTA
  // can hand /simulation a finding= index (the page treats findings by
  // spec-curve position, not raw cluster id).
  const findingIndex = useMemo(() => {
    if (!curve || !row) return null;
    const idx = curve.rows.findIndex((r) => r.cluster_id === row.cluster_id);
    return idx >= 0 ? idx : null;
  }, [curve, row]);
  const representative = useMemo(
    () => (row ? cleanRepresentative(row.representative) : ''),
    [row],
  );

  return (
    <StudyShell
      data={data}
      eyebrow={`Scenario ${id}`}
      title={row ? humanScenarioTitle(row) : 'Scenario summary'}
      intro={
        row
          ? 'One defensible framing of the same question — its plain-language summary, its key numbers, and the evidence behind it.'
          : 'Pick a scenario from the robustness grid.'
      }
      back={{
        href: withStudy('/robustness', studyId),
        label: 'Back to all scenarios',
      }}
    >
      {!studyId ? null : loadingCurve || !curve ? (
        <FocusCard tone="muted">
          <div className="grid gap-3">
            <div className="h-6 w-2/3 animate-pulse rounded-lg bg-slate-200" />
            <div className="h-4 w-1/2 animate-pulse rounded-full bg-slate-200" />
          </div>
        </FocusCard>
      ) : !row ? (
        <FocusCard>
          <p className="text-sm text-slate-600">
            Scenario <span className="font-semibold">{id}</span> isn&apos;t in
            the latest robustness grid for this study. The grid rebuilds on
            every load —{' '}
            <Link
              href={withStudy('/robustness', studyId)}
              className="font-medium text-slate-900 underline-offset-4 hover:underline"
            >
              open the robustness grid
            </Link>{' '}
            to see the current list of scenarios.
          </p>
        </FocusCard>
      ) : (
        <>
          <FocusCard>
            <div className="grid gap-3">
              <RobustnessHeader row={row} />
              <p className="text-balance text-base leading-relaxed text-slate-800">
                {representative}
              </p>
            </div>
          </FocusCard>

          <FocusCard>
            <div className="grid gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Key numbers
                </h3>
                <span className="text-[11px] leading-snug text-slate-500">
                  Across the {row.n_agree + row.n_weaker + row.n_flips + row.n_missing} framings tried so far
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Metric
                  value={String(row.n_agree)}
                  label="scenarios agree"
                  tone="emerald"
                />
                <Metric
                  value={String(row.n_weaker)}
                  label="scenarios weaker"
                  tone="amber"
                />
                <Metric
                  value={String(row.n_flips)}
                  label="scenarios flip"
                  tone="orange"
                />
              </div>
              {row.fragile_specs.length > 0 ? (
                <p className="text-[12px] leading-snug text-slate-600">
                  <span className="font-semibold text-slate-700">
                    Falls apart when
                  </span>
                  :{' '}
                  {row.fragile_specs
                    .slice(0, 3)
                    .map((spec) => humanizeSpecKey(spec, cells))
                    .join('; ')}
                  {row.fragile_specs.length > 3
                    ? ` (+${row.fragile_specs.length - 3} more framings)`
                    : ''}
                  .
                </p>
              ) : null}
            </div>
          </FocusCard>

          <FocusCard>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Framings inside this scenario
            </h3>
            <p className="mt-1 text-[12px] leading-snug text-slate-500">
              {breakdown.agree.length} agree, {breakdown.weaker.length}{' '}
              weaker, and {breakdown.flips.length} flip — these are the
              dimension combinations that voted on this scenario.
            </p>
            <div className="mt-3 grid gap-3">
              <CellGroup
                label="Agree"
                cells={breakdown.agree}
                tone="emerald"
              />
              <CellGroup
                label="Weaker"
                cells={breakdown.weaker}
                tone="amber"
              />
              <CellGroup
                label="Flip"
                cells={breakdown.flips}
                tone="orange"
              />
            </div>
          </FocusCard>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={withStudy('/evidence', studyId, {
                cluster: String(row.cluster_id),
              })}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-slate-950 px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
            >
              See evidence for this scenario
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
            <Link
              href={withStudy('/simulation', studyId, {
                finding:
                  findingIndex != null
                    ? String(findingIndex)
                    : String(row.cluster_id),
                prompt: 'discount-vs-bundle',
              })}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 text-[12px] font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              <Beaker className="h-3.5 w-3.5" />
              Run a counter-scenario
            </Link>
          </div>
        </>
      )}
    </StudyShell>
  );
}

function RobustnessHeader({ row }: { row: SpecCurveRow }) {
  const pct = Math.round(row.robustness * 100);
  const total = row.n_agree + row.n_weaker + row.n_flips + row.n_missing;
  const tone =
    pct >= 70
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : pct >= 40
        ? 'border-yellow-200 bg-yellow-50 text-yellow-700'
        : 'border-orange-200 bg-orange-50 text-orange-700';
  const phrasing =
    total === 0
      ? 'No framings have voted yet'
      : total === 1
        ? row.n_agree >= 1
          ? 'Holds in 1 of 1 framing'
          : 'Does not hold in this single framing'
        : pct < 50 && row.n_agree > 0
          ? `Limited support — only ${row.n_agree} of ${total} framings agree`
          : `Holds in ${row.n_agree} of ${total} framings`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[12px] font-semibold shadow-sm',
          tone,
        )}
      >
        {phrasing}
      </span>
      <span className="text-[11px] text-slate-500">
        Robustness {pct}%
      </span>
    </div>
  );
}

function Metric({
  value,
  label,
  tone,
}: {
  value: string;
  label: string;
  tone: 'emerald' | 'amber' | 'orange';
}) {
  const cls = {
    emerald: 'border-emerald-200 bg-emerald-50/70 text-emerald-900',
    amber: 'border-yellow-200 bg-yellow-50/70 text-yellow-900',
    orange: 'border-orange-200 bg-orange-50/70 text-orange-900',
  }[tone];
  return (
    <div className={cn('grid gap-1 rounded-2xl border px-3 py-3 shadow-sm', cls)}>
      <span className="text-2xl font-bold leading-none tabular-nums">
        {value}
      </span>
      <span className="text-[10px] font-semibold uppercase tracking-wider opacity-80">
        {label}
      </span>
    </div>
  );
}

function CellGroup({
  label,
  cells,
  tone,
}: {
  label: string;
  cells: CellSummary[];
  tone: 'emerald' | 'amber' | 'orange';
}) {
  if (cells.length === 0) return null;
  const cls = {
    emerald: 'border-emerald-200 bg-emerald-50/70',
    amber: 'border-yellow-200 bg-yellow-50/70',
    orange: 'border-orange-200 bg-orange-50/70',
  }[tone];
  return (
    <div className={cn('rounded-2xl border p-3', cls)}>
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-700">
        {label}
        <span className="text-[10px] font-semibold text-slate-500">
          {cells.length}
        </span>
      </div>
      <ul className="mt-2 grid gap-2">
        {cells.slice(0, 12).map((cell) => (
          <li
            key={cell.id}
            className="rounded-lg bg-white/80 px-3 py-2 text-[11px] shadow-sm"
          >
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5">
              {describeCellAxes(cell).map(
                ({ dimension, valueDisplay }) => (
                  <div key={dimension} className="contents">
                    <dt className="text-[10px] uppercase tracking-wide text-slate-500">
                      {dimension.replace(/_/g, ' ')}
                    </dt>
                    <dd className="font-medium text-slate-800">
                      {valueDisplay}
                    </dd>
                  </div>
                ),
              )}
            </dl>
          </li>
        ))}
        {cells.length > 12 ? (
          <li className="text-[10px] text-slate-500">
            +{cells.length - 12} more framings
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function humanScenarioTitle(row: SpecCurveRow): string {
  const text = cleanRepresentative(row.representative);
  if (!text) return `Scenario ${row.cluster_id} summary`;
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  const cleaned = firstSentence.replace(/[.!?]+$/, '').trim();
  return cleaned.length > 0 ? cleaned : `Scenario ${row.cluster_id} summary`;
}

function breakDownByStatus(
  row: SpecCurveRow | null,
  cells: CellSummary[],
): { agree: CellSummary[]; weaker: CellSummary[]; flips: CellSummary[] } {
  if (!row) return { agree: [], weaker: [], flips: [] };
  const groups: Record<CellRowStatus, CellSummary[]> = {
    agree: [],
    weaker: [],
    flips: [],
    missing: [],
  };
  for (const cell of cells) {
    const status = row.statuses[cell.id];
    if (!status) continue;
    groups[status].push(cell);
  }
  return { agree: groups.agree, weaker: groups.weaker, flips: groups.flips };
}


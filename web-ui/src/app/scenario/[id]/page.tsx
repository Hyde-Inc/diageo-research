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
import { ArrowLeft, ArrowRight, ShieldAlert } from 'lucide-react';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { Badge } from '@/components/ui/badge';
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

  return (
    <StudyShell
      data={data}
      eyebrow={`Scenario #${id}`}
      title={row ? truncate(row.representative, 90) : 'Scenario'}
      intro={
        row
          ? 'One defensible framing of the question, and the evidence behind it.'
          : 'Pick a scenario from the robustness grid.'
      }
      back={{ href: withStudy('/robustness', studyId), label: 'Back to all scenarios' }}
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
            No cluster <span className="font-mono">#{id}</span> on the
            current spec curve. The curve gets rebuilt every time the page
            loads — try{' '}
            <Link
              href={withStudy('/robustness', studyId)}
              className="font-medium text-slate-900 underline-offset-4 hover:underline"
            >
              the stoplight grid
            </Link>{' '}
            for the up-to-date list.
          </p>
        </FocusCard>
      ) : (
        <>
          <FocusCard>
            <div className="grid gap-3">
              <RobustnessHeader row={row} />
              <p className="text-balance text-base leading-relaxed text-slate-800">
                {row.representative}
              </p>
            </div>
          </FocusCard>

          <FocusCard>
            <div className="grid gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Key numbers
              </h3>
              <div className="grid grid-cols-3 gap-2">
                <Metric
                  value={String(row.n_agree)}
                  label="cells agree"
                  tone="emerald"
                />
                <Metric
                  value={String(row.n_weaker)}
                  label="cells weaker"
                  tone="amber"
                />
                <Metric
                  value={String(row.n_flips)}
                  label="cells flip"
                  tone="orange"
                />
              </div>
              {row.fragile_specs.length > 0 ? (
                <p className="text-[12px] text-slate-600">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Fragile under
                  </span>{' '}
                  · {row.fragile_specs.slice(0, 3).join(', ')}
                  {row.fragile_specs.length > 3
                    ? ` (+${row.fragile_specs.length - 3} more)`
                    : ''}
                </p>
              ) : null}
            </div>
          </FocusCard>

          <FocusCard>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Cells in this scenario
            </h3>
            <p className="mt-1 text-[12px] leading-snug text-slate-500">
              The {breakdown.agree.length} green, {breakdown.weaker.length}{' '}
              amber, and {breakdown.flips.length} orange cells that
              produced this scenario&apos;s vote.
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
              href={withStudy('/robustness', studyId)}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 text-[12px] font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Compare to another scenario
            </Link>
            <Link
              href={withStudy(`/evidence/${row.cluster_id}`, studyId)}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-slate-950 px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
            >
              See evidence
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
            <Link
              href={withStudy('/why-it-could-be-wrong', studyId)}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 text-[12px] font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              Falsifiers
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
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[12px] font-semibold shadow-sm',
          tone,
        )}
      >
        {pct}% robust
      </span>
      <span className="font-mono text-[11px] text-slate-500">
        {row.n_agree}/{total} cells agree
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
      <span className="font-mono text-[10px] uppercase tracking-wider opacity-80">
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
        <span className="font-mono text-[10px] text-slate-500">
          {cells.length}
        </span>
      </div>
      <ul className="mt-2 grid gap-1">
        {cells.slice(0, 12).map((cell) => (
          <li
            key={cell.id}
            className="flex flex-wrap items-center gap-1.5 rounded-lg bg-white/70 px-2 py-1 text-[11px] shadow-sm"
          >
            {Object.entries(cell.axes).map(([axis, value]) => (
              <Badge
                key={axis}
                variant="outline"
                className="border-slate-200 bg-white font-mono text-[10px] text-slate-700"
              >
                <span className="text-slate-500">{axis}</span>
                <span className="mx-0.5 text-slate-400">·</span>
                {value}
              </Badge>
            ))}
            <span className="ml-auto font-mono text-[10px] text-slate-400">
              {cell.id}
            </span>
          </li>
        ))}
        {cells.length > 12 ? (
          <li className="text-[10px] text-slate-500">
            +{cells.length - 12} more
          </li>
        ) : null}
      </ul>
    </div>
  );
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

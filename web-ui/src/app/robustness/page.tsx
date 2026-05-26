'use client';

/**
 * /robustness — stoplight grid over the spec curve.
 *
 * Each "scenario" is a recommendation cluster. We colour it by its
 * robustness score:
 *   green ≥ 0.7
 *   amber 0.4 – 0.7
 *   red   < 0.4
 *
 * Hover or focus reveals a plain-English description (the cluster's
 * representative line). Click navigates to /scenario/[cluster_id] so
 * the user lands on the focused single-scenario view.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { cn } from '@/lib/utils';
import type { SpecCurveRow } from '@/components/workbench/types';

export default function RobustnessPage() {
  const data = useStudyData();
  const { curve, loadingCurve, studyId } = data;

  return (
    <StudyShell
      data={data}
      eyebrow="Robustness"
      title="Each square is a defensible way to look at the question."
      intro="Green: the answer holds. Amber: partial agreement. Red: this framing changes the answer."
    >
      {!studyId ? null : loadingCurve || !curve ? (
        <FocusCard tone="muted">
          <SkeletonGrid />
        </FocusCard>
      ) : curve.rows.length === 0 ? (
        <FocusCard>
          <p className="text-sm text-slate-600">
            No clustered scenarios yet — the briefs haven&apos;t produced
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
        <FocusCard>
          <StopLightGrid rows={curve.rows} studyId={studyId} />
          <Legend />
        </FocusCard>
      )}
    </StudyShell>
  );
}

function StopLightGrid({
  rows,
  studyId,
}: {
  rows: SpecCurveRow[];
  studyId: string | null;
}) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
      {rows.map((row) => (
        <ScenarioSquare key={row.cluster_id} row={row} studyId={studyId} />
      ))}
    </div>
  );
}

function ScenarioSquare({
  row,
  studyId,
}: {
  row: SpecCurveRow;
  studyId: string | null;
}) {
  const tone = toneFor(row.robustness);
  const pct = Math.round(row.robustness * 100);
  const summary = describeRow(row);
  return (
    <Link
      href={withStudy(`/scenario/${row.cluster_id}`, studyId)}
      className="group relative aspect-square"
      title={summary}
      aria-label={`Scenario ${row.cluster_id}: ${summary}`}
    >
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-1 rounded-2xl border p-2 text-center shadow-sm transition-all',
          'group-hover:-translate-y-0.5 group-hover:shadow-md',
          tone.cls,
        )}
      >
        <span className="font-mono text-[10px] uppercase tracking-wider opacity-70">
          #{row.cluster_id}
        </span>
        <span className="text-2xl font-bold leading-none tabular-nums">
          {pct}%
        </span>
        <span className="font-mono text-[9px] uppercase tracking-wider opacity-70">
          {tone.label}
        </span>
      </div>
      <div
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 w-64 max-w-[80vw] -translate-x-1/2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-[11px] leading-snug text-slate-700 opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus:opacity-100"
      >
        <p className="line-clamp-4">{summary}</p>
        <p className="mt-1 inline-flex items-center gap-1 font-mono text-[9px] text-slate-500">
          {row.n_agree} agree · {row.n_weaker} weaker · {row.n_flips} flip
          <ArrowRight className="h-2.5 w-2.5" />
        </p>
      </div>
    </Link>
  );
}

function describeRow(row: SpecCurveRow): string {
  return row.representative.trim();
}

function toneFor(robustness: number): { cls: string; label: string } {
  if (robustness >= 0.7) {
    return {
      cls: 'border-emerald-200 bg-emerald-100 text-emerald-900',
      label: 'holds',
    };
  }
  if (robustness >= 0.4) {
    return {
      cls: 'border-yellow-200 bg-yellow-100 text-yellow-900',
      label: 'mixed',
    };
  }
  return {
    cls: 'border-orange-200 bg-orange-100 text-orange-900',
    label: 'flips',
  };
}

function Legend() {
  return (
    <ul className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-500">
      <li className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-3 rounded-[3px] bg-emerald-300" />
        Holds in most cells (≥ 70%)
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-3 rounded-[3px] bg-yellow-300" />
        Mixed support (40–70%)
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-3 rounded-[3px] bg-orange-300" />
        Flips under most cells (&lt; 40%)
      </li>
    </ul>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="aspect-square animate-pulse rounded-2xl bg-slate-200/70"
        />
      ))}
    </div>
  );
}

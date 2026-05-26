'use client';

/**
 * /scenario — landing page that nudges to a specific scenario.
 *
 * The dynamic /scenario/[id] view is where the real content lives. We
 * keep this page minimal: a list of scenarios in robustness order so a
 * user who clicks the global "Scenario" tab can pick one without
 * bouncing back to /robustness.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { cn } from '@/lib/utils';
import type { SpecCurveRow } from '@/components/workbench/types';

export default function ScenarioIndexPage() {
  const data = useStudyData();
  const { curve, loadingCurve, studyId } = data;

  return (
    <StudyShell
      data={data}
      eyebrow="Scenario"
      title="Pick a scenario."
      intro="Each scenario is one defensible framing of the same question. Open one to see its recommendation and key numbers."
    >
      {!studyId ? null : loadingCurve || !curve ? (
        <FocusCard tone="muted">
          <div className="grid gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-12 animate-pulse rounded-xl bg-slate-200/70"
              />
            ))}
          </div>
        </FocusCard>
      ) : curve.rows.length === 0 ? (
        <FocusCard>
          <p className="text-sm text-slate-600">
            No scenarios yet — the briefs haven&apos;t produced
            recommendation-shaped sentences for this study.
          </p>
        </FocusCard>
      ) : (
        <FocusCard>
          <ul className="grid gap-2">
            {curve.rows.map((row) => (
              <ScenarioRow key={row.cluster_id} row={row} studyId={studyId} />
            ))}
          </ul>
        </FocusCard>
      )}
    </StudyShell>
  );
}

function ScenarioRow({
  row,
  studyId,
}: {
  row: SpecCurveRow;
  studyId: string | null;
}) {
  const pct = Math.round(row.robustness * 100);
  const tone =
    pct >= 70
      ? 'border-emerald-200 bg-emerald-50/60 text-emerald-900'
      : pct >= 40
        ? 'border-yellow-200 bg-yellow-50/60 text-yellow-900'
        : 'border-orange-200 bg-orange-50/60 text-orange-900';
  return (
    <li>
      <Link
        href={withStudy(`/scenario/${row.cluster_id}`, studyId)}
        className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-sm transition-all hover:-translate-y-0.5 hover:border-slate-400"
      >
        <span
          className={cn(
            'inline-flex h-9 w-12 items-center justify-center rounded-xl border font-mono text-xs font-semibold tabular-nums shadow-sm',
            tone,
          )}
        >
          {pct}%
        </span>
        <span className="line-clamp-2 text-[13px] leading-snug text-slate-800">
          {row.representative}
        </span>
        <ArrowRight className="h-3.5 w-3.5 text-slate-300 transition-colors group-hover:text-slate-700" />
      </Link>
    </li>
  );
}

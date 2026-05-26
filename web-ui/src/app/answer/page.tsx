'use client';

/**
 * /answer — the plain-language answer for the active study.
 *
 * Deliberately spartan: one big sentence, one robustness pill, one
 * caveat, one CTA. Anything more lives one click away on /robustness
 * or /why-it-could-be-wrong.
 */

import Link from 'next/link';
import { ArrowRight, ShieldAlert, Sparkles } from 'lucide-react';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { SpecCurve } from '@/components/workbench/types';

export default function AnswerPage() {
  const data = useStudyData();
  const { detail, curve, loadingCurve, loadingDetail, studyId } = data;
  const lead = curve?.rows[0] ?? null;

  return (
    <StudyShell
      data={data}
      eyebrow="Answer"
      title="Plain-language recommendation"
      intro="The single line we'd put in the executive briefing for this study."
    >
      {!studyId ? null : loadingDetail || loadingCurve ? (
        <FocusCard tone="muted">
          <div className="grid gap-3">
            <div className="h-4 w-1/3 animate-pulse rounded-full bg-slate-200" />
            <div className="h-7 w-3/4 animate-pulse rounded-lg bg-slate-200" />
            <div className="h-4 w-2/3 animate-pulse rounded-full bg-slate-100" />
          </div>
        </FocusCard>
      ) : !curve || !lead ? (
        <FocusCard>
          <div className="grid gap-3">
            <div className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
              <Sparkles className="h-3.5 w-3.5" /> No answer yet
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">
              {detail?.question ?? 'No question registered for this study.'}
            </h2>
            <p className="text-sm leading-snug text-slate-600">
              No clustered recommendations yet — either the study is still
              running or no scenario has produced a brief. Check{' '}
              <Link
                href={withStudy('/setup', studyId)}
                className="font-medium text-slate-900 underline-offset-4 hover:underline"
              >
                Setup
              </Link>{' '}
              for status.
            </p>
          </div>
        </FocusCard>
      ) : (
        <>
          <FocusCard>
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-slate-300 bg-white text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500"
                >
                  Question
                </Badge>
                {detail ? (
                  <span className="text-[12px] leading-snug text-slate-500">
                    {detail.question}
                  </span>
                ) : null}
              </div>
              <h2 className="text-balance text-2xl font-semibold leading-snug tracking-tight text-slate-950 md:text-[26px]">
                {lead.representative}
              </h2>
              <RobustnessPill curve={curve} />
              <Caveat curve={curve} fragileSpecs={lead.fragile_specs} />
            </div>
          </FocusCard>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={withStudy('/robustness', studyId)}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-slate-950 px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
            >
              Go deeper
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
            <Link
              href={withStudy('/why-it-could-be-wrong', studyId)}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 text-[12px] font-medium text-slate-600 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              Why it could be wrong
            </Link>
          </div>
        </>
      )}
    </StudyShell>
  );
}

function RobustnessPill({ curve }: { curve: SpecCurve }) {
  const totalScenarios = curve.rows.reduce((acc, r) => {
    return acc + (r.n_agree > 0 || r.n_weaker > 0 || r.n_flips > 0 ? 1 : 0);
  }, 0);
  const lead = curve.rows[0];
  const inFavour = lead.n_agree;
  const total = lead.n_agree + lead.n_weaker + lead.n_flips + lead.n_missing;
  const tone =
    lead.robustness >= 0.7
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : lead.robustness >= 0.4
        ? 'border-yellow-200 bg-yellow-50 text-yellow-700'
        : 'border-orange-200 bg-orange-50 text-orange-700';
  const dotTone =
    lead.robustness >= 0.7
      ? 'bg-emerald-500'
      : lead.robustness >= 0.4
        ? 'bg-yellow-500'
        : 'bg-orange-500';
  return (
    <div className="grid gap-1">
      <span
        className={cn(
          'inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-[12px] font-semibold shadow-sm',
          tone,
        )}
      >
        <span className={cn('h-1.5 w-1.5 rounded-full', dotTone)} />
        Holds in {inFavour} of {total} scenarios
      </span>
      {totalScenarios > 0 ? (
        <p className="text-[11px] text-slate-500">
          {curve.rows.length} candidate recommendations clustered across{' '}
          {curve.cells.length} cells.
        </p>
      ) : null}
    </div>
  );
}

function Caveat({
  curve,
  fragileSpecs,
}: {
  curve: SpecCurve;
  fragileSpecs: string[];
}) {
  const triggered = curve.falsifier_status === 'fully_triggered';
  const partial = curve.falsifier_status === 'partially_triggered';
  let sentence: string;
  if (triggered) {
    sentence =
      'A falsifier condition triggered — read the caveats before acting on this answer.';
  } else if (partial) {
    sentence =
      'Some falsifier conditions are borderline or need bespoke checks before this is decision-grade.';
  } else if (fragileSpecs.length > 0) {
    const preview = fragileSpecs.slice(0, 2).join(', ');
    const more =
      fragileSpecs.length > 2 ? ` (+${fragileSpecs.length - 2} more)` : '';
    sentence = `Fragile under ${preview}${more} — flips when those framings are used.`;
  } else {
    sentence =
      'No falsifier triggered and the lead recommendation survives every defensible framing.';
  }
  return <p className="text-sm leading-snug text-slate-600">{sentence}</p>;
}

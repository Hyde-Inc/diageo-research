'use client';

/**
 * /answer — the plain-language answer for the active study.
 *
 * Deliberately spartan: one big sentence, one robustness pill, one
 * caveat, one CTA. Anything more lives one click away on /robustness
 * or /why-it-could-be-wrong.
 */

import Link from 'next/link';
import { ArrowRight, HelpCircle, Sparkles } from 'lucide-react';
import { ConfidencePanel } from '@/components/study/confidence-panel';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { SpecCurve } from '@/components/workbench/types';

export default function AnswerPage() {
  const data = useStudyData();
  const { detail, curve, loadingCurve, loadingDetail, prereg, studyId } = data;
  const lead = curve?.rows[0] ?? null;

  return (
    <StudyShell
      data={data}
      eyebrow="Answer"
      title="The plain-language answer"
      intro="The single recommendation we would put in the executive briefing for this study, with one piece of evidence and one explicit confidence pill."
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
              <EvidenceChip studyId={studyId} />
              <Caveat curve={curve} fragileSpecs={lead.fragile_specs} />
            </div>
          </FocusCard>
          <ConfidencePanel
            curve={curve}
            prereg={prereg}
            interval={{
              kind: 'confidence interval',
              available: false,
              requiredData:
                'observed outcome data or a holdout sample tied to the agreed decision rule.',
            }}
            provenance={{
              source: 'Study pre-registration, scenario outputs, and evidence traces',
              transformation: 'Recommendation clustering and robustness scoring',
              output: 'Executive answer plus caveats',
              available: true,
            }}
            raiseConfidence={[
              'Attach observed outcome data so the answer can carry a real confidence interval.',
              'Review any scenario framings where the recommendation weakens or flips.',
              'Validate that the conditions that would prove us wrong are still acceptable to stakeholders.',
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={withStudy('/robustness', studyId)}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-slate-950 px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
            >
              Go deeper
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </>
      )}
    </StudyShell>
  );
}

function RobustnessPill({ curve }: { curve: SpecCurve }) {
  const lead = curve.rows[0];
  const inFavour = lead.n_agree;
  const total = lead.n_agree + lead.n_weaker + lead.n_flips + lead.n_missing;
  const tone =
    lead.robustness >= 0.7
      ? {
          pill: 'border-emerald-200 bg-emerald-50 text-emerald-700',
          dot: 'bg-emerald-500',
          bar: 'bg-emerald-500',
        }
      : lead.robustness >= 0.4
        ? {
            pill: 'border-yellow-200 bg-yellow-50 text-yellow-700',
            dot: 'bg-yellow-500',
            bar: 'bg-yellow-500',
          }
        : {
            pill: 'border-orange-200 bg-orange-50 text-orange-700',
            dot: 'bg-orange-500',
            bar: 'bg-orange-500',
          };
  const phrasing =
    total === 0
      ? 'Confidence not computed — no scenarios have finished yet'
      : total === 1
        ? inFavour >= 1
          ? 'Holds in 1 of 1 scenario'
          : 'Does not hold in this single scenario'
        : lead.robustness < 0.5 && inFavour > 0
          ? `Limited support — only ${inFavour} of ${total} framings agree`
          : `Holds in ${inFavour} of ${total} scenarios`;
  const pct = total > 0 ? Math.round(lead.robustness * 100) : 0;
  return (
    <div className="grid gap-1">
      <span
        className={cn(
          'inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-[12px] font-semibold shadow-sm',
          tone.pill,
        )}
      >
        <span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} />
        {phrasing}
      </span>
      {total > 0 ? (
        <div className="h-1 w-40 max-w-full overflow-hidden rounded-full bg-slate-100">
          <div className={cn('h-full', tone.bar)} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function EvidenceChip({ studyId }: { studyId: string | null }) {
  if (!studyId) return null;
  return (
    <Link
      href={withStudy('/evidence', studyId)}
      className="inline-flex w-fit items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-400 hover:bg-white"
    >
      <HelpCircle className="h-3 w-3 text-slate-500" />
      Research brief evidence
    </Link>
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
      'A condition that would prove us wrong triggered — read the caveats before acting on this answer.';
  } else if (partial) {
    sentence =
      'Some conditions that would prove us wrong are borderline or need bespoke checks before this is decision-grade.';
  } else if (fragileSpecs.length > 0) {
    const preview = fragileSpecs.slice(0, 2).join(', ');
    const more =
      fragileSpecs.length > 2 ? ` (+${fragileSpecs.length - 2} more)` : '';
    sentence = `Fragile under ${preview}${more} — flips when those framings are used.`;
  } else {
    sentence =
      'No wrong-way condition triggered and the lead recommendation survives every defensible framing.';
  }
  return <p className="text-sm leading-snug text-slate-600">{sentence}</p>;
}

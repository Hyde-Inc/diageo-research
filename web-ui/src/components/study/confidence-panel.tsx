import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Prereg, SpecCurve } from '@/components/workbench/types';

export type ConfidenceLevel = 'High' | 'Medium' | 'Low' | 'Needs data';

type IntervalInput = {
  kind: 'confidence interval' | 'prediction interval';
  available: boolean;
  value?: string;
  requiredData: string;
  note?: string;
};

type ProvenanceInput = {
  source: string;
  transformation: string;
  output: string;
  available?: boolean;
};

export function ConfidencePanel({
  curve,
  prereg,
  interval,
  provenance,
  raiseConfidence,
  className,
  studyId,
  clusterId,
}: {
  curve: SpecCurve | null;
  prereg?: Prereg | null;
  interval?: IntervalInput;
  provenance?: ProvenanceInput;
  raiseConfidence?: string[];
  className?: string;
  // Optional context for turning each check into a clickable row that
  // lands on a surface the user can act on. When omitted the rows
  // render as plain summary cards (legacy behaviour).
  studyId?: string | null;
  clusterId?: number | null;
}) {
  const lead = curve?.rows[0] ?? null;
  const total =
    lead != null
      ? lead.n_agree + lead.n_weaker + lead.n_flips + lead.n_missing
      : 0;
  const intervalAvailable = interval?.available === true;
  const level = deriveConfidenceLevel(curve, intervalAvailable);
  const intervalLabel = interval?.kind ?? 'prediction interval';
  const source =
    provenance?.source ??
    'Pre-registered study setup and connected research artefacts';
  const transformation =
    provenance?.transformation ??
    'Scenario clustering, rubric checks, and robustness comparison';
  const output =
    provenance?.output ??
    (curve ? 'Spec curve and recommendation cluster available' : 'Output not available yet');
  const provenanceAvailable = provenance?.available ?? Boolean(curve);
  const raises = raiseConfidence ?? defaultRaiseConfidence(intervalLabel);

  return (
    <section
      id="confidence-panel"
      className={cn(
        'rounded-3xl border border-slate-200 bg-white/95 p-5 shadow-sm shadow-slate-950/[0.04]',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            Confidence and verifiability
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-950">
            Three checks before trusting the answer
          </h2>
        </div>
        <Badge
          variant="outline"
          className={cn(
            'border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]',
            LEVEL_TONE[level],
          )}
        >
          {level}
        </Badge>
      </div>

      <div className="mt-4 grid gap-3">
        <TrustCheck
          title="1. Agreed bar / rubric"
          status={
            intervalAvailable
              ? `${sentenceCase(intervalLabel)}: ${interval?.value ?? 'estimated'}`
              : `${sentenceCase(intervalLabel)}: not yet estimated`
          }
          detail={[
            prereg?.decision_rule
              ? `Decision rule: ${prereg.decision_rule}`
              : 'Decision rule is not loaded for this surface.',
            lead
              ? `Rubric agreement: ${lead.n_agree} of ${total} scenario framings support the lead recommendation.`
              : 'Rubric agreement is waiting on a completed spec curve.',
            intervalAvailable
              ? (interval?.note ?? 'Interval is available from connected outcome data.')
              : `Required data: ${interval?.requiredData ?? 'connected outcome or holdout observations tied to this study.'}`,
          ]}
          tone={intervalAvailable ? 'ready' : 'needs-data'}
          actionHref={
            studyId
              ? `/setup?study=${studyId}&focus=holdout${clusterId != null ? `&cluster=${clusterId}` : ''}`
              : null
          }
          actionLabel="Open holdout setup"
        />
        <TrustCheck
          title="2. Provenance"
          status={provenanceAvailable ? 'Trace available' : 'Trace incomplete'}
          detail={[`${source} -> ${transformation} -> ${output}`]}
          tone={provenanceAvailable ? 'ready' : 'needs-data'}
          actionHref={
            studyId
              ? `/assets?study=${studyId}${clusterId != null ? `&cluster=${clusterId}` : ''}`
              : null
          }
          actionLabel="See provenance trace"
        />
        <TrustCheck
          title="3. Robustness"
          status={
            lead
              ? `Spec agreement: ${(lead.robustness * 100).toFixed(0)}%`
              : 'Spec agreement: not available'
          }
          detail={[
            lead
              ? `${lead.n_flips} flips, ${lead.n_weaker} weaker, ${lead.n_missing} missing across ${total} scenario framings.`
              : 'Run scenarios across agreed dimensions before treating the answer as robust.',
            curve?.falsifier_status
              ? `What would prove us wrong status: ${curve.falsifier_status.replace(/_/g, ' ')}.`
              : 'What would prove us wrong status is pending.',
          ]}
          tone={
            !lead || curve?.falsifier_status === 'fully_triggered'
              ? 'needs-data'
              : lead.robustness >= 0.7
                ? 'ready'
                : lead.robustness >= 0.4
                  ? 'watch'
                  : 'risk'
          }
          actionHref={
            studyId
              ? `/robustness?study=${studyId}${clusterId != null ? `&cluster=${clusterId}` : ''}`
              : null
          }
          actionLabel="Open robustness view"
        />
      </div>

      <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
        <h3 className="text-[12px] font-semibold text-slate-900">
          What would raise confidence?
        </h3>
        <ul className="mt-2 grid gap-1.5 text-[12px] leading-snug text-slate-600">
          {raises.map((item) => (
            <li key={item} className="flex gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function TrustCheck({
  title,
  status,
  detail,
  tone,
  actionHref,
  actionLabel,
}: {
  title: string;
  status: string;
  detail: string[];
  tone: 'ready' | 'watch' | 'risk' | 'needs-data';
  actionHref?: string | null;
  actionLabel?: string;
}) {
  const inner = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]',
            CHECK_TONE[tone],
          )}
        >
          {status}
        </span>
      </div>
      <div className="mt-2 grid gap-1 text-[12px] leading-snug text-slate-600">
        {detail.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {actionHref ? (
        <p className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-slate-700 group-hover:underline">
          {actionLabel ?? 'Open'}
          <ArrowRight
            className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        </p>
      ) : null}
    </>
  );
  if (actionHref) {
    return (
      <Link
        href={actionHref}
        className="group block rounded-2xl border border-slate-200 bg-white p-4 text-left transition-colors hover:border-slate-300 hover:bg-slate-50"
      >
        {inner}
      </Link>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      {inner}
    </div>
  );
}

function deriveConfidenceLevel(
  curve: SpecCurve | null,
  intervalAvailable: boolean,
): ConfidenceLevel {
  const lead = curve?.rows[0] ?? null;
  if (!lead || !intervalAvailable) return 'Needs data';
  if (curve?.falsifier_status === 'fully_triggered' || lead.robustness < 0.4) {
    return 'Low';
  }
  if (lead.robustness >= 0.7 && lead.n_flips === 0) return 'High';
  return 'Medium';
}

function defaultRaiseConfidence(intervalLabel: string): string[] {
  return [
    `Estimate a real ${intervalLabel} from connected promo, loyalty, or holdout outcome data.`,
    'Keep the decision rule and thresholds agreed before reading the answer.',
    'Run sensitivity cuts for the exposed segment and review any flips.',
  ];
}

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const LEVEL_TONE: Record<ConfidenceLevel, string> = {
  High: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  Medium: 'border-yellow-200 bg-yellow-50 text-yellow-700',
  Low: 'border-orange-200 bg-orange-50 text-orange-700',
  'Needs data': 'border-slate-300 bg-slate-50 text-slate-600',
};

const CHECK_TONE = {
  ready: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  watch: 'border-yellow-200 bg-yellow-50 text-yellow-700',
  risk: 'border-orange-200 bg-orange-50 text-orange-700',
  'needs-data': 'border-slate-300 bg-slate-50 text-slate-600',
};

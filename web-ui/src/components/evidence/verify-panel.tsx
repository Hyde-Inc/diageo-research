'use client';

/**
 * Small "Verify" summary panel that sits at the top of /evidence/[id].
 *
 * Mirrors the three-check pattern of ``ConfidencePanel`` on /answer but
 * scoped to one claim: rubric (agreement), provenance (sources
 * available), robustness (does the claim hold across scenarios).
 *
 * Everything is text — no "100% robust" chips, no "lens·solo" badges.
 */

import { CheckCircle2, Circle, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SpecCurveRow } from '@/components/workbench/types';
import {
  agreementToneClass,
  formatSourceSummary,
  summarizeAgreement,
  type SourceSummary,
} from './claim-utils';

type CheckTone = 'ready' | 'watch' | 'risk' | 'needs-data';

export function VerifyPanel({
  row,
  sources,
  hasSources,
  loadingSources,
}: {
  row: SpecCurveRow;
  sources: SourceSummary;
  hasSources: boolean;
  loadingSources: boolean;
}) {
  const agree = summarizeAgreement(row);
  const robustnessTone: CheckTone =
    agree.tone === 'strong'
      ? 'ready'
      : agree.tone === 'mixed'
        ? 'watch'
        : agree.tone === 'weak'
          ? 'risk'
          : 'needs-data';
  const provenanceTone: CheckTone = loadingSources
    ? 'needs-data'
    : hasSources
      ? 'ready'
      : 'risk';
  const rubricTone: CheckTone =
    row.n_flips > 0 ? 'risk' : agree.tone === 'strong' ? 'ready' : 'watch';

  return (
    <section className="rounded-3xl border border-slate-200 bg-white/95 p-5 shadow-sm shadow-slate-950/[0.04]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            Verify this claim
          </p>
          <h2 className="mt-1 text-base font-semibold tracking-tight text-slate-950">
            Three checks before trusting the claim
          </h2>
        </div>
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]',
            agreementToneClass(agree.tone),
          )}
        >
          {agree.text}
        </span>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <Check
          title="Rubric"
          status={
            row.n_flips > 0
              ? `${row.n_flips} scenario${row.n_flips === 1 ? '' : 's'} flip the claim`
              : 'No scenarios flip the claim'
          }
          detail={
            row.n_weaker > 0
              ? `${row.n_weaker} scenario${row.n_weaker === 1 ? '' : 's'} support a weaker form.`
              : 'All evaluated scenarios are at least supportive.'
          }
          tone={rubricTone}
        />
        <Check
          title="Provenance"
          status={
            loadingSources
              ? 'Loading sources…'
              : hasSources
                ? formatSourceSummary(sources)
                : 'No sources cited yet'
          }
          detail={
            hasSources
              ? 'Each source is listed below with a link or the SQL query.'
              : 'The brief did not cite any verifiable sources for this claim.'
          }
          tone={provenanceTone}
        />
        <Check
          title="Robustness"
          status={agree.text}
          detail={
            agree.total <= 1
              ? 'Only one scenario has been run — add more scenarios to stress-test.'
              : `Spawning more counter-scenarios will widen the test.`
          }
          tone={robustnessTone}
        />
      </div>
    </section>
  );
}

function Check({
  title,
  status,
  detail,
  tone,
}: {
  title: string;
  status: string;
  detail: string;
  tone: CheckTone;
}) {
  const Icon =
    tone === 'ready'
      ? CheckCircle2
      : tone === 'risk'
        ? ShieldAlert
        : Circle;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            'h-3.5 w-3.5',
            tone === 'ready'
              ? 'text-emerald-600'
              : tone === 'risk'
                ? 'text-orange-600'
                : tone === 'watch'
                  ? 'text-yellow-600'
                  : 'text-slate-400',
          )}
        />
        <h3 className="text-[12px] font-semibold text-slate-900">{title}</h3>
      </div>
      <p className="mt-1 text-[12px] font-medium leading-snug text-slate-800">
        {status}
      </p>
      <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{detail}</p>
    </div>
  );
}

'use client';

/**
 * Screen 2 — Claim → evidence chain (auditability).
 *
 * Separates what was OBSERVED in the data (the cited measurements —
 * internal SQL results and public statistics, pulled straight from the
 * source) from what was INFERRED by grounded simulation (the claim
 * itself, reasoned by the panel from those observations and tested
 * across framings). Makes the chain from evidence to inference
 * challengeable rather than a single undifferentiated answer.
 *
 * Derives from the same final.json citations + spec-curve row the rest
 * of the page already loads; no new data dependency.
 */

import { Eye, Sparkles } from 'lucide-react';
import type { RunCitation, SpecCurveRow } from '@/components/workbench/types';
import { sourceLabel } from './claim-utils';
import { classifyCitationTier } from './source-tier';

function dedupeLabels(citations: RunCitation[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of citations) {
    const label = sourceLabel(c);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

export function ObservedInferredSplit({
  claim,
  citations,
  row,
}: {
  claim: string;
  citations: RunCitation[];
  row: SpecCurveRow | null;
}) {
  const labels = dedupeLabels(citations);
  const diageoCount = citations.filter(
    (c) => classifyCitationTier(c).tier === 'diageo',
  ).length;
  const total = row
    ? row.n_agree + row.n_weaker + row.n_flips + row.n_missing
    : 0;
  const agree = row?.n_agree ?? 0;

  return (
    <div
      data-validation="auditability"
      className="grid gap-3 rounded-3xl border border-slate-200 bg-white/95 p-5 shadow-sm shadow-slate-950/[0.04] sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-tight text-slate-900">
          What was observed vs. what was inferred
        </h3>
        <span className="text-[11px] text-slate-500">
          Hyde separates measured facts from grounded inference, so each
          can be challenged on its own terms.
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <section className="grid gap-2 rounded-2xl border border-blue-200 bg-blue-50/60 p-4">
          <header className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-blue-700" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-800">
              Observed in the data
            </span>
          </header>
          {labels.length > 0 ? (
            <>
              <p className="text-[12px] leading-snug text-slate-700">
                {labels.length} cited{' '}
                {labels.length === 1 ? 'source' : 'sources'} (
                {diageoCount} Diageo-owned) — measured or queried directly,
                not modeled.
              </p>
              <ul className="grid gap-1">
                {labels.slice(0, 5).map((label) => (
                  <li
                    key={label}
                    className="rounded-lg border border-white bg-white px-2.5 py-1 text-[12px] text-slate-700 shadow-sm"
                  >
                    {label}
                  </li>
                ))}
                {labels.length > 5 ? (
                  <li className="text-[11px] text-slate-500">
                    +{labels.length - 5} more in Sources below
                  </li>
                ) : null}
              </ul>
            </>
          ) : (
            <p className="text-[12px] italic leading-snug text-slate-500">
              No verifiable sources were cited for this claim — treat it as
              unobserved until evidence is attached.
            </p>
          )}
        </section>

        <section className="grid gap-2 rounded-2xl border border-violet-200 bg-violet-50/60 p-4">
          <header className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-700" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-violet-800">
              Inferred by grounded simulation
            </span>
          </header>
          <p className="text-[12px] leading-snug text-slate-800">
            &ldquo;{claim}&rdquo;
          </p>
          <p className="text-[11px] leading-snug text-slate-600">
            {total > 0 ? (
              <>
                The panel&apos;s grounded inference from the observations on
                the left — it holds in{' '}
                <span className="font-semibold text-slate-900">
                  {agree} of {total}
                </span>{' '}
                framings. It is a conclusion, not itself a measured number.
              </>
            ) : (
              <>
                The panel&apos;s grounded inference from the observations on
                the left — a conclusion, not itself a measured number.
              </>
            )}
          </p>
        </section>
      </div>
    </div>
  );
}

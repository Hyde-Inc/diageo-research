'use client';

/**
 * Screen 1 — Grounded evidence base.
 *
 * Splits the sources behind a claim into "Diageo-owned" (primary) and
 * "Public" (enriching), each with a one-line "speaks to / can't speak
 * to" scope. Diageo-owned is listed first and styled as primary so the
 * reader sees that the simulation starts from approved internal
 * evidence, not the model's generic priors.
 *
 * Derives entirely from the real final.json citations via the pure
 * source-tier classifier, so it renders the seeded hero study and any
 * live study (whose Diageo-owned tier is its internal SQL citations)
 * with no special-casing.
 */

import { Database, Globe2, ShieldCheck } from 'lucide-react';
import type { RunCitation } from '@/components/workbench/types';
import { sourceLabel } from './claim-utils';
import { classifyCitationTier, type TierClassification } from './source-tier';

type TieredSource = {
  label: string;
  scope: TierClassification;
};

function dedupeByLabel(citations: RunCitation[]): TieredSource[] {
  const seen = new Set<string>();
  const out: TieredSource[] = [];
  for (const c of citations) {
    const label = sourceLabel(c);
    const scope = classifyCitationTier(c);
    const key = `${label}::${scope.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, scope });
  }
  return out;
}

export function GroundedEvidenceBase({
  citations,
}: {
  citations: RunCitation[];
}) {
  const sources = dedupeByLabel(citations);
  const diageo = sources.filter((s) => s.scope.tier === 'diageo');
  const publicSrc = sources.filter((s) => s.scope.tier === 'public');

  if (sources.length === 0) return null;

  return (
    <div
      data-validation="grounding"
      className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-indigo-600" />
          <h4 className="text-[13px] font-semibold text-slate-900">
            Grounded evidence base
          </h4>
        </div>
        <p className="text-[11px] text-slate-500">
          Diageo-owned sources are primary; public sources enrich, they
          don&apos;t replace them.
        </p>
      </div>

      <TierBlock
        tone="diageo"
        Icon={Database}
        title="Diageo-owned"
        caption="Approved internal evidence — the simulation starts here."
        sources={diageo}
        emptyNote="No named Diageo-owned source cited for this claim yet."
      />
      <TierBlock
        tone="public"
        Icon={Globe2}
        title="Public"
        caption="External context that enriches, but isn't treated as equivalent."
        sources={publicSrc}
        emptyNote="No public source cited for this claim."
      />
    </div>
  );
}

function TierBlock({
  tone,
  Icon,
  title,
  caption,
  sources,
  emptyNote,
}: {
  tone: 'diageo' | 'public';
  Icon: typeof Database;
  title: string;
  caption: string;
  sources: TieredSource[];
  emptyNote: string;
}) {
  const accent =
    tone === 'diageo'
      ? 'border-indigo-200 bg-indigo-50/60'
      : 'border-slate-200 bg-slate-50/70';
  const chip =
    tone === 'diageo'
      ? 'bg-indigo-100 text-indigo-700'
      : 'bg-slate-200 text-slate-600';
  return (
    <section className={`grid gap-2 rounded-2xl border p-3 ${accent}`}>
      <header className="flex items-center gap-2">
        <Icon
          className={
            tone === 'diageo' ? 'h-3.5 w-3.5 text-indigo-600' : 'h-3.5 w-3.5 text-slate-500'
          }
        />
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-700">
          {title}
        </span>
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${chip}`}
        >
          {sources.length}
        </span>
        <span className="text-[11px] text-slate-500">{caption}</span>
      </header>
      {sources.length === 0 ? (
        <p className="text-[12px] italic text-slate-500">{emptyNote}</p>
      ) : (
        <ul className="grid gap-1.5">
          {sources.map((s) => (
            <li
              key={`${s.label}-${s.scope.category}`}
              className="rounded-xl border border-white bg-white px-3 py-2 shadow-sm"
            >
              <p className="text-[12px] font-semibold text-slate-900">
                {s.label}
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-600">
                <span className="font-medium text-emerald-700">Speaks to:</span>{' '}
                {s.scope.speaksTo}
              </p>
              <p className="text-[11px] leading-snug text-slate-500">
                <span className="font-medium text-orange-600">
                  Can&apos;t speak to:
                </span>{' '}
                {s.scope.cantSpeakTo}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

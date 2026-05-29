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
 * Each observed source is shown with the detail a reader needs to
 * actually verify it — the queried table / URL, the measured value, and
 * the brief's own verification result — not just a source name. The
 * inferred side names which observed inputs feed the claim, the
 * spec-curve mechanism that stress-tested it, and links to the scenario
 * artifact so it's falsifiable rather than self-asserting.
 *
 * Derives from the same final.json citations + spec-curve row the rest
 * of the page already loads; no new data dependency.
 */

import Link from 'next/link';
import {
  CheckCircle2,
  Database,
  Eye,
  FileText,
  Globe2,
  Sparkles,
  XCircle,
} from 'lucide-react';
import type { RunCitation, SpecCurveRow } from '@/components/workbench/types';
import { withStudy } from '@/components/study/use-study';
import { sourceLabel } from './claim-utils';
import { classifyCitationTier } from './source-tier';
import {
  cleanObservedValue,
  groupCitations,
  summarizeVerification,
  type VerificationSummary,
} from './source-helpers';

const MAX_DETAILED = 4;

type ObservedKind = { label: string; Icon: typeof Database; cls: string };

function observedKind(c: RunCitation): ObservedKind {
  if (c.source === 'duckdb') {
    return {
      label: 'SQL result',
      Icon: Database,
      cls: 'border-violet-200 bg-violet-50 text-violet-700',
    };
  }
  if (c.url) {
    return {
      label: 'Public stat',
      Icon: Globe2,
      cls: 'border-blue-200 bg-blue-50 text-blue-700',
    };
  }
  return {
    label: 'Internal doc',
    Icon: FileText,
    cls: 'border-slate-200 bg-slate-50 text-slate-700',
  };
}

function trimSql(sql: string): string {
  const cleaned = sql.replace(/\s+/g, ' ').trim();
  return cleaned.length <= 180 ? cleaned : `${cleaned.slice(0, 177)}…`;
}

function VerificationChip({ v }: { v: VerificationSummary }) {
  const cls =
    v.status === 'verified'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : v.status === 'unverified'
        ? 'border-orange-200 bg-orange-50 text-orange-700'
        : v.status === 'attested'
          ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
          : 'border-slate-200 bg-slate-50 text-slate-500';
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}
      >
        {v.status === 'verified' ? (
          <CheckCircle2 className="h-3 w-3" />
        ) : v.status === 'unverified' ? (
          <XCircle className="h-3 w-3" />
        ) : null}
        {v.label}
      </span>
      {v.note ? (
        <span className="text-[10px] leading-snug text-slate-500">{v.note}</span>
      ) : null}
    </span>
  );
}

function ObservedSource({ c }: { c: RunCitation }) {
  const kind = observedKind(c);
  const label = sourceLabel(c);
  const value = cleanObservedValue(c);
  const verification = summarizeVerification(c);
  return (
    <li className="grid gap-1.5 rounded-xl border border-white bg-white px-3 py-2 shadow-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${kind.cls}`}
        >
          <kind.Icon className="h-3 w-3" />
          {kind.label}
        </span>
        <span className="min-w-0 flex-1 break-words text-[12px] font-semibold text-slate-900">
          {label}
        </span>
        <span className="shrink-0 font-mono text-[9px] font-semibold tracking-wider text-slate-400">
          [{c.cite_id}]
        </span>
      </div>
      {c.source === 'duckdb' && c.sql ? (
        <pre className="overflow-x-auto rounded-md bg-slate-50 px-2 py-1 font-mono text-[10px] leading-snug text-slate-600">
          {trimSql(c.sql)}
        </pre>
      ) : null}
      {value ? (
        <p className="text-[11px] leading-snug text-slate-700">
          <span className="font-medium text-slate-500">Measured:</span> {value}
        </p>
      ) : (
        <p className="text-[11px] italic leading-snug text-slate-400">
          No extractable value — open the source to inspect.
        </p>
      )}
      <VerificationChip v={verification} />
    </li>
  );
}

export function ObservedInferredSplit({
  claim,
  citations,
  row,
  referencedIds,
  studyId,
}: {
  claim: string;
  citations: RunCitation[];
  row: SpecCurveRow | null;
  referencedIds: string[];
  studyId: string | null;
}) {
  const groups = groupCitations(citations);
  const sources = groups.map((g) => g.primary);
  const detailed = sources.slice(0, MAX_DETAILED);
  const diageoCount = citations.filter(
    (c) => classifyCitationTier(c).tier === 'diageo',
  ).length;

  const total = row
    ? row.n_agree + row.n_weaker + row.n_flips + row.n_missing
    : 0;
  const agree = row?.n_agree ?? 0;
  const weaker = row?.n_weaker ?? 0;
  const flips = row?.n_flips ?? 0;
  const missing = row?.n_missing ?? 0;
  const cited = referencedIds.filter((id) =>
    citations.some((c) => c.cite_id === id),
  );

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
          {sources.length > 0 ? (
            <>
              <p className="text-[12px] leading-snug text-slate-700">
                {sources.length} cited{' '}
                {sources.length === 1 ? 'source' : 'sources'} ({diageoCount}{' '}
                Diageo-owned) — each shown with the query or document, the
                value measured, and whether the brief&apos;s verifier could
                re-run it.
              </p>
              <ul className="grid gap-1.5">
                {detailed.map((c) => (
                  <ObservedSource key={c.cite_id} c={c} />
                ))}
                {sources.length > detailed.length ? (
                  <li className="text-[11px] text-slate-500">
                    +{sources.length - detailed.length} more, with full query
                    text and verification, in Sources below
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
            {cited.length > 0 ? (
              <>
                Reasoned from the observed inputs it cites —{' '}
                <span className="font-mono text-[10px] text-slate-700">
                  {cited.join(' ')}
                </span>{' '}
                on the left. It is a conclusion drawn from those measurements,
                not itself a measured number.
              </>
            ) : (
              <>
                Reasoned from the {sources.length} observed{' '}
                {sources.length === 1 ? 'source' : 'sources'} on the left. It
                is a conclusion drawn from those measurements, not itself a
                measured number.
              </>
            )}
          </p>
          {total > 0 ? (
            <div className="grid gap-1.5 rounded-xl border border-violet-100 bg-white/70 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-700">
                How it was stress-tested
              </p>
              <p className="text-[11px] leading-snug text-slate-600">
                Re-run across{' '}
                <span className="font-semibold text-slate-900">{total}</span>{' '}
                defensible framings (the spec curve):{' '}
                <span className="font-semibold text-emerald-700">
                  {agree} agree
                </span>{' '}
                ·{' '}
                <span className="font-semibold text-yellow-700">
                  {weaker} weaker
                </span>{' '}
                ·{' '}
                <span className="font-semibold text-orange-700">
                  {flips} flip
                </span>{' '}
                · <span className="text-slate-500">{missing} no-data</span>.
              </p>
              {row ? (
                <Link
                  href={withStudy(`/scenario/${row.cluster_id}`, studyId)}
                  className="text-[11px] font-semibold text-violet-700 underline-offset-2 hover:underline"
                >
                  Inspect the framings that tested it →
                </Link>
              ) : null}
            </div>
          ) : (
            <p className="text-[11px] leading-snug text-slate-500">
              Not yet stress-tested across framings — add scenarios to test
              whether the conclusion holds.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

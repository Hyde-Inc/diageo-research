'use client';

/**
 * One clickable source card on the /evidence/[id] detail page.
 *
 * Replaces the "lens·solo" dimension badges with real, human-readable
 * source labels from final.json's citation list (BLS, BEA, DISCUS,
 * internal SQL, etc.). Each card shows:
 *
 *   - the source label (or a "Unlabeled source (run …)" fallback);
 *   - a kind chip ("Web doc" / "SQL result");
 *   - an excerpt of the snippet, query, or URL;
 *   - the verification badge from the brief's own verifier;
 *   - a link out (URL for web; falls back to a "copy SQL" affordance
 *     for SQL citations — kept inline because there's no SQL viewer
 *     elsewhere in the FE yet).
 */

import {
  ArrowUpRight,
  CheckCircle2,
  Database,
  Globe2,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { RunCitation } from '@/components/workbench/types';
import { citationKind, hostFromUrl, sourceLabel } from './claim-utils';
import {
  isGarbageSnippet,
  SNIPPET_UNAVAILABLE_FALLBACK,
  VERIFIER_BADGE_TOOLTIP,
} from './source-helpers';

export type SourceCardProps = {
  citation: RunCitation;
  /** Cite ids this card represents (when grouped with duplicates). */
  aliases?: string[];
  /**
   * Preferred snippet (e.g. the sentence from the brief paragraph
   * that names this cite). Used in place of the raw scraped snippet
   * for web docs when set, since the paragraph-derived sentence is
   * the curated context the analyst saw.
   */
  preferredSnippet?: string | null;
  /** Extra snippets discovered during dedupe, rendered collapsed. */
  extraSnippets?: string[];
};

export function SourceCard({
  citation,
  aliases = [],
  preferredSnippet = null,
  extraSnippets = [],
}: SourceCardProps) {
  const kind = citationKind(citation);
  const label = sourceLabel(citation);
  const host = hostFromUrl(citation.url);
  const verified = citation.verified;

  // For web docs, prefer the curated paragraph-derived sentence; the
  // raw scraped snippet is often binary / page chrome. SQL keeps its
  // own renderer below.
  const rawSnippet = citation.snippet?.trim() ?? '';
  const snippetIsGarbage = isGarbageSnippet(rawSnippet);
  const renderedSnippet =
    kind === 'web' && preferredSnippet
      ? preferredSnippet
      : kind === 'web' && snippetIsGarbage
        ? null
        : rawSnippet || null;

  return (
    <article className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-slate-300">
      <header className="flex flex-wrap items-start gap-2">
        <KindChip kind={kind} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">
            {label}
          </p>
          {host ? (
            <p className="truncate text-[11px] text-slate-500">{host}</p>
          ) : null}
        </div>
        <span className="font-mono text-[10px] font-semibold tracking-wider text-slate-400">
          [{citation.cite_id}]
        </span>
      </header>

      {aliases.length > 0 ? (
        <p className="text-[10px] uppercase tracking-wider text-slate-500">
          cited as{' '}
          <span className="font-mono text-slate-700">[{citation.cite_id}]</span>
          {aliases.map((a) => (
            <span key={a} className="font-mono text-slate-700">
              {' '}[{a}]
            </span>
          ))}
        </p>
      ) : null}

      {kind === 'sql' && citation.sql ? (
        <pre className="max-h-32 overflow-auto rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] leading-snug text-slate-700">
          {trimSql(citation.sql)}
        </pre>
      ) : renderedSnippet ? (
        <p className="line-clamp-3 text-[12px] leading-snug text-slate-600">
          {renderedSnippet}
        </p>
      ) : kind === 'web' ? (
        <p className="text-[12px] italic leading-snug text-slate-500">
          {SNIPPET_UNAVAILABLE_FALLBACK}
        </p>
      ) : null}

      {extraSnippets.length > 0 ? (
        <details className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-1.5 text-[11px]">
          <summary className="cursor-pointer font-medium text-slate-700">
            See {extraSnippets.length} other snippet
            {extraSnippets.length === 1 ? '' : 's'} from grouped citations
          </summary>
          <ul className="mt-1.5 grid gap-1">
            {extraSnippets.map((snippet) => (
              <li
                key={snippet}
                className="rounded-md bg-white px-2 py-1 text-slate-600 shadow-inner"
              >
                {snippet}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <footer className="flex flex-wrap items-center gap-2 pt-1">
        {typeof verified === 'boolean' ? (
          <span
            title={VERIFIER_BADGE_TOOLTIP}
            className={cn(
              'inline-flex cursor-help items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
              verified
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-orange-200 bg-orange-50 text-orange-700',
            )}
          >
            {verified ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <XCircle className="h-3 w-3" />
            )}
            {verified ? 'Verified' : 'Unverified'}
          </span>
        ) : null}
        {citation.verification_note ? (
          <span className="text-[10px] text-slate-500">
            {citation.verification_note}
          </span>
        ) : null}
        {citation.url ? (
          <a
            href={citation.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-slate-700 underline-offset-2 hover:text-slate-950 hover:underline"
          >
            Open source
            <ArrowUpRight className="h-3 w-3" />
          </a>
        ) : null}
      </footer>
    </article>
  );
}

function KindChip({ kind }: { kind: 'web' | 'sql' | 'doc' }) {
  const map = {
    web: {
      label: 'Web doc',
      Icon: Globe2,
      cls: 'border-blue-200 bg-blue-50 text-blue-700',
    },
    sql: {
      label: 'SQL result',
      Icon: Database,
      cls: 'border-violet-200 bg-violet-50 text-violet-700',
    },
    doc: {
      label: 'Internal doc',
      Icon: Database,
      cls: 'border-slate-200 bg-slate-50 text-slate-700',
    },
  } as const;
  const { label, Icon, cls } = map[kind];
  return (
    <Badge
      variant="outline"
      className={cn('shrink-0 gap-1 px-2 py-0.5 text-[10px]', cls)}
    >
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );
}

function trimSql(sql: string): string {
  const cleaned = sql.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 240) return cleaned;
  return cleaned.slice(0, 237) + '…';
}

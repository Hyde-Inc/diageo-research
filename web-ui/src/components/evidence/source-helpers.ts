/**
 * Helpers for cleaning, deduping, and triaging the per-claim source
 * list on /evidence/[id]. Kept side-effect free so the components
 * stay thin and these can be unit-tested without a React render.
 *
 * Rules captured from the redesign brief:
 *   - Snippet looks like binary or page chrome → suppress, show a
 *     fallback "Snippet not extractable" line.
 *   - Multiple citations from the same canonical URL/host get grouped
 *     into one card with a "cited as [Sx] [Sy]" header.
 *   - Verifier failures with re-exec / catalog / 0-row notes get
 *     promoted to a separate VerifierFlags section.
 */

import type { RunCitation } from '@/components/workbench/types';
import { hostFromUrl } from './claim-utils';

// ─── Garbage snippet detection ──────────────────────────────────────

const PAGE_CHROME_PREFIXES = [
  'PK!',
  '[Content_Types].xml',
  'ormation you provide is encrypted',
  'X Is this page helpful?',
  'United States government Here is how you know',
];

/**
 * Return ``true`` when the snippet is unsafe to render as evidence —
 * binary blob, archive header, or known page-chrome boilerplate.
 *
 * The heuristic: less than 60% printable ASCII, or one of a small
 * known list of page-chrome prefixes that show up in scraped docs.
 */
export function isGarbageSnippet(snippet: string | null | undefined): boolean {
  if (!snippet) return false;
  const text = snippet.trim();
  if (text.length === 0) return false;
  for (const prefix of PAGE_CHROME_PREFIXES) {
    if (text.startsWith(prefix)) return true;
  }
  // Count printable ASCII (space..tilde + common whitespace) over the
  // first 400 characters; anything below 60% is almost certainly a
  // binary or encoding-broken blob.
  const sample = text.slice(0, 400);
  let printable = 0;
  for (const c of sample) {
    const code = c.charCodeAt(0);
    if (
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 32 && code <= 126)
    ) {
      printable += 1;
    }
  }
  return printable / sample.length < 0.6;
}

/**
 * Within a brief paragraph, locate the sentence that names the given
 * cite id (e.g. ``[S3]``) and return it trimmed. Falls back to the
 * paragraph itself when the marker isn't present. Used to surface a
 * curated snippet on web SourceCards in preference to whatever raw
 * scraped text the browser tool deposited.
 */
export function findCiteSentence(
  paragraph: string | null | undefined,
  cite_id: string,
): string | null {
  if (!paragraph || !cite_id) return null;
  const marker = `[${cite_id}]`;
  const idx = paragraph.indexOf(marker);
  if (idx === -1) return null;
  // Walk back to start of sentence
  let start = idx;
  while (start > 0) {
    const ch = paragraph.charCodeAt(start - 1);
    if (ch === 46 || ch === 33 || ch === 63 || ch === 10) break; // . ! ? \n
    start -= 1;
  }
  // Walk forward to end of sentence (after the cite marker)
  let end = idx + marker.length;
  while (end < paragraph.length) {
    const ch = paragraph.charCodeAt(end);
    if (ch === 46 || ch === 33 || ch === 63) {
      end += 1;
      break;
    }
    end += 1;
  }
  return paragraph.slice(start, end).trim();
}

// ─── Citation grouping / dedupe ─────────────────────────────────────

export type CitationGroup = {
  primary: RunCitation;
  aliases: string[];
  members: RunCitation[];
  snippets: string[];
};

/**
 * Group citations whose URL (canonical host + path) match AND whose
 * snippets are identical (or both garbage). The first member becomes
 * the ``primary`` card; the other cite ids appear as ``aliases`` on
 * the card header. SQL citations are grouped by SQL string equality
 * since they have no URL.
 */
export function groupCitations(
  citations: RunCitation[],
): CitationGroup[] {
  const groups: CitationGroup[] = [];
  for (const c of citations) {
    const key = groupKey(c);
    const existing = key ? groups.find((g) => groupKey(g.primary) === key) : null;
    if (existing) {
      existing.aliases.push(c.cite_id);
      existing.members.push(c);
      const snippet = c.snippet?.trim();
      if (snippet && !existing.snippets.includes(snippet)) {
        existing.snippets.push(snippet);
      }
      continue;
    }
    const snippet = c.snippet?.trim();
    groups.push({
      primary: c,
      aliases: [],
      members: [c],
      snippets: snippet ? [snippet] : [],
    });
  }
  return groups;
}

function groupKey(c: RunCitation): string | null {
  if (c.source === 'duckdb' && c.sql) {
    return `sql:${c.sql.replace(/\s+/g, ' ').trim()}`;
  }
  if (c.url) {
    const host = hostFromUrl(c.url) ?? '';
    try {
      const u = new URL(c.url);
      // Drop tracking params; keep host + path for canonical match.
      return `web:${host}${u.pathname}`;
    } catch {
      return `web:${c.url}`;
    }
  }
  return null;
}

// ─── Verifier flags ─────────────────────────────────────────────────

const VERIFIER_FAILURE_NOTE = /^re-exec error|catalog error|table.*does not exist|0 rows but citation cites/i;

export type VerifierFlag = {
  cite_id: string;
  kind: 'web' | 'sql' | 'doc';
  note: string;
};

export function extractVerifierFlags(
  citations: RunCitation[],
): VerifierFlag[] {
  const out: VerifierFlag[] = [];
  for (const c of citations) {
    if (c.verified !== false) continue;
    const note = (c.verification_note ?? '').trim();
    if (!VERIFIER_FAILURE_NOTE.test(note)) continue;
    out.push({
      cite_id: c.cite_id,
      kind: c.source === 'duckdb' ? 'sql' : 'web',
      note,
    });
  }
  return out;
}

export const VERIFIER_BADGE_TOOLTIP =
  'The verifier re-runs the cited SQL or re-extracts numbers from the cited URL and checks every numeric value the brief quoted. Higher percentages mean the claim’s numbers survived re-verification.';

export const SNIPPET_UNAVAILABLE_FALLBACK =
  'Snippet not extractable — open the source URL to view.';

/**
 * Helpers that turn raw workbench shapes (spec curve rows, final.json
 * citations, dagster materializations) into the plain-language inputs
 * the verification UX needs.
 *
 * Kept framework-free and side-effect free so the components stay thin
 * and the helpers can be exercised without a React render.
 *
 * Vocabulary follows the audit-pane-for-jargon skill:
 *   - "scenario" instead of "cell"
 *   - "dimension" instead of "axis"
 *   - no "lens·solo" badges; we use the dimension's label and surface
 *     the underlying source name (BLS, BEA, etc.) wherever possible.
 */

import type {
  CellSummary,
  Materialization,
  RunCitation,
  SpecCurveRow,
} from '@/components/workbench/types';

// ─── Claim title extraction ─────────────────────────────────────────

/**
 * Pull a short, readable claim title from the cluster's representative
 * recommendation. The representative line is often a 2–3 sentence
 * paragraph; we want the first declarative sentence trimmed to a
 * one-line label.
 *
 * The function strips trailing citation markers (`[S1]`, `[S2]`) so the
 * title reads like a sentence, then truncates at the first period (or
 * semicolon) if the result fits in ``maxLen``.
 */
export function extractClaimTitle(
  representative: string,
  maxLen = 140,
): string {
  const cleaned = representative
    .replace(/\s*\[(S|B|Q)\d+\](\s*\[(S|B|Q)\d+\])*/g, '')
    // Strip markdown bullet markers / bold markers / leading "Lead
    // recommendation:" or "Recommendation:" labels that some persona
    // sub-reports prepend to the actual sentence.
    .replace(/^\s*[-*•]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*(Lead recommendation|Recommendation|Headline)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Look for the first sentence break that leaves a reasonable title.
  const breakRe = /([.;])\s+(?=[A-Z(])/;
  const m = cleaned.match(breakRe);
  if (m && m.index != null && m.index >= 40 && m.index < maxLen) {
    return cleaned.slice(0, m.index + 1).trim();
  }
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1).trimEnd() + '…';
}

// ─── Claim referenced citations ─────────────────────────────────────

const CITE_RE = /\[(S|B|Q)\d+\]/g;

export function extractCiteIds(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  CITE_RE.lastIndex = 0;
  while ((m = CITE_RE.exec(text)) !== null) {
    out.add(m[0].slice(1, -1));
  }
  return Array.from(out);
}

// ─── Source labeling ────────────────────────────────────────────────

const KNOWN_SOURCES: Array<{ test: (host: string) => boolean; label: string }> =
  [
    { test: (h) => h.endsWith('bls.gov'), label: 'Bureau of Labor Statistics' },
    {
      test: (h) => h.endsWith('bea.gov'),
      label: 'Bureau of Economic Analysis',
    },
    { test: (h) => h.endsWith('ttb.gov'), label: 'TTB (Tax & Trade Bureau)' },
    { test: (h) => h.endsWith('census.gov'), label: 'US Census Bureau' },
    { test: (h) => h.endsWith('fred.stlouisfed.org'), label: 'FRED · St Louis Fed' },
    {
      test: (h) => h.endsWith('discus.org'),
      label: 'DISCUS · Distilled Spirits Council',
    },
    {
      test: (h) => h.endsWith('restaurant.org'),
      label: 'National Restaurant Association',
    },
    {
      test: (h) => h.endsWith('iwsr.com') || h.endsWith('theiwsr.com'),
      label: 'IWSR Drinks Market Analysis',
    },
    {
      test: (h) => h.endsWith('nielseniq.com') || h.endsWith('nielsen.com'),
      label: 'NielsenIQ',
    },
    { test: (h) => h.endsWith('circana.com'), label: 'Circana' },
    { test: (h) => h.endsWith('statista.com'), label: 'Statista' },
    { test: (h) => h.endsWith('sevenfiftydaily.com') || h.endsWith('daily.sevenfifty.com'), label: 'SevenFifty Daily' },
    {
      test: (h) => h.endsWith('wikipedia.org'),
      label: 'Wikipedia',
    },
  ];

export function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function sourceLabel(citation: RunCitation): string {
  if (citation.source === 'duckdb') {
    return 'Internal SQL query';
  }
  if (citation.title) {
    // Prefer the document title when we have one — it's the human-
    // readable label, not a URL fragment.
    const t = citation.title.split('|')[0].trim();
    if (t.length > 4 && t.length < 90) return t;
  }
  const host = hostFromUrl(citation.url);
  if (host) {
    for (const k of KNOWN_SOURCES) {
      if (k.test(host)) return k.label;
    }
    return host;
  }
  return 'Unlabeled web source';
}

export type SourceKind = 'web' | 'sql' | 'doc';

export function citationKind(citation: RunCitation): SourceKind {
  if (citation.source === 'duckdb') return 'sql';
  // We don't yet have a separate "internal doc" pipeline, so every
  // browser-fetched citation is classified as "web". When the parallel
  // worker ships a doc kind we can branch on title or url scheme here.
  return 'web';
}

export type SourceSummary = {
  web: number;
  sql: number;
  doc: number;
  total: number;
};

export function summarizeCitations(citations: RunCitation[]): SourceSummary {
  const out: SourceSummary = { web: 0, sql: 0, doc: 0, total: 0 };
  for (const c of citations) {
    const k = citationKind(c);
    out[k] += 1;
    out.total += 1;
  }
  return out;
}

export function formatSourceSummary(s: SourceSummary): string {
  const parts: string[] = [];
  if (s.web) parts.push(`${s.web} web ${s.web === 1 ? 'doc' : 'docs'}`);
  if (s.sql) parts.push(`${s.sql} SQL ${s.sql === 1 ? 'result' : 'results'}`);
  if (s.doc)
    parts.push(`${s.doc} internal ${s.doc === 1 ? 'doc' : 'docs'}`);
  if (parts.length === 0) return 'No sources cited yet';
  return parts.join(' · ');
}

// ─── Confidence pill text (plain language, no "100%" chips) ─────────

export type AgreementSummary = {
  agree: number;
  total: number;
  text: string;
  tone: 'strong' | 'mixed' | 'weak' | 'unknown';
};

export function summarizeAgreement(
  row: SpecCurveRow | null,
): AgreementSummary {
  if (!row) {
    return { agree: 0, total: 0, text: 'Not yet evaluated', tone: 'unknown' };
  }
  const total = row.n_agree + row.n_weaker + row.n_flips + row.n_missing;
  const agree = row.n_agree;
  if (total === 0) {
    return { agree, total, text: 'Not yet evaluated', tone: 'unknown' };
  }
  const scenarioWord = total === 1 ? 'scenario' : 'scenarios';
  const text = `${agree} of ${total} ${scenarioWord} agree`;
  const ratio = agree / total;
  const tone =
    ratio >= 0.75 ? 'strong' : ratio >= 0.4 ? 'mixed' : 'weak';
  return { agree, total, text, tone };
}

export function agreementToneClass(tone: AgreementSummary['tone']): string {
  switch (tone) {
    case 'strong':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'mixed':
      return 'border-yellow-200 bg-yellow-50 text-yellow-700';
    case 'weak':
      return 'border-orange-200 bg-orange-50 text-orange-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-600';
  }
}

// ─── Sentence-in-paragraph extraction ───────────────────────────────

/**
 * Try to locate the claim's representative sentence inside the
 * markdown brief and return the paragraph that contains it. Useful for
 * the detail page's "see full paragraph" toggle.
 *
 * Returns ``null`` when the brief is missing or the sentence cannot be
 * located — the caller renders the representative line standalone in
 * that case, with an honest "couldn't locate the surrounding paragraph"
 * note instead of pretending we have richer context than we do.
 */
export function findClaimParagraph(
  markdown: string | undefined,
  representative: string,
): { paragraph: string; sentence: string } | null {
  if (!markdown) return null;
  const sentence = representative.trim();
  if (!sentence) return null;

  // Match the first 60 chars of the cleaned representative; the spec
  // curve uses a slightly trimmed version of the brief's sentence so an
  // exact match isn't always possible.
  const probe = sentence
    .replace(/\s*\[(S|B|Q)\d+\](\s*\[(S|B|Q)\d+\])*/g, '')
    .slice(0, 60)
    .trim();
  if (probe.length < 24) return null;

  const idx = markdown.indexOf(probe);
  if (idx === -1) return null;

  // Walk backwards / forwards to a blank-line paragraph boundary.
  let start = idx;
  while (start > 0) {
    if (markdown.startsWith('\n\n', start - 2)) {
      start = start; // boundary just before the matched character.
      break;
    }
    start -= 1;
  }
  let end = idx + probe.length;
  while (end < markdown.length) {
    if (markdown.startsWith('\n\n', end)) break;
    end += 1;
  }
  const paragraph = markdown.slice(start, end).trim();
  if (!paragraph) return null;
  return { paragraph, sentence };
}

// ─── Stage label translation (no model names, no raw $) ─────────────

const STAGE_LABELS: Record<string, { title: string; description: string }> = {
  question_analysis: {
    title: 'Question analysis',
    description:
      'Restate the question and pick the analyst perspectives the study needs.',
  },
  personas: {
    title: 'Analyst personas',
    description:
      'Generate the cast of analyst personas that will research the question.',
  },
  outline: {
    title: 'Brief outline',
    description: 'Draft the section outline before any persona starts work.',
  },
  outline_seed: {
    title: 'Brief outline',
    description: 'Draft the section outline before any persona starts work.',
  },
  assign_sections: {
    title: 'Assign sections',
    description: 'Give each persona the sections they are responsible for.',
  },
  interviews: {
    title: 'Analyst interviews',
    description:
      'Each persona runs SQL or fetches sources to answer their slice of the question.',
  },
  perspective: {
    title: 'Analyst interview',
    description:
      'A single persona runs SQL or fetches sources for one slice of the question.',
  },
  subreports: {
    title: 'Persona sub-reports',
    description: 'Each persona writes up their answer with citations.',
  },
  verifier: {
    title: 'Citation verifier',
    description:
      'Cross-check every citation against its source before the brief is written.',
  },
  synthesis: {
    title: 'Synthesize brief',
    description:
      'Merge the persona sub-reports and verified citations into the final brief.',
  },
  summarizer_section: {
    title: 'Synthesize sections',
    description: 'Merge the persona sub-reports into one brief, section by section.',
  },
  final: {
    title: 'Final brief',
    description:
      'Assemble the synthesized sections into the brief you read on /answer.',
  },
  final_md: {
    title: 'Final brief',
    description:
      'Assemble the synthesized sections into the brief you read on /answer.',
  },
  research_cell: {
    title: 'Brief assembled',
    description: 'The brief is ready and the receipt is written to disk.',
  },
};

export type StagePlain = {
  title: string;
  description: string;
  raw_stage: string;
  elapsed_s?: number | null;
  spent_usd?: number | null;
  n_calls?: number | null;
};

export function describeStage(mat: Materialization): StagePlain {
  const known = STAGE_LABELS[mat.stage];
  if (known) {
    return {
      title: known.title,
      description: known.description,
      raw_stage: mat.stage,
      elapsed_s: mat.elapsed_s ?? null,
      spent_usd: mat.spent_usd ?? null,
      n_calls: mat.n_calls ?? null,
    };
  }
  // Unknown stage names: render the slug humanized so we don't leak
  // internal tokens like ``summarizer_section`` to stakeholders.
  const title = mat.stage
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    title,
    description: 'Pipeline step.',
    raw_stage: mat.stage,
    elapsed_s: mat.elapsed_s ?? null,
    spent_usd: mat.spent_usd ?? null,
    n_calls: mat.n_calls ?? null,
  };
}

// ─── Cell label helpers ─────────────────────────────────────────────

/**
 * Render a cell's dimensions as a short human-readable string, e.g.
 * "cohort: sub60k · cycle: full_cycle". We deliberately drop the
 * "lens·solo" pattern used elsewhere — the dimension name reads better
 * than a packed bullet glyph for stakeholders.
 *
 * The special ``{lens: 'solo'}`` axis is the multiverse's placeholder
 * for a single-scenario study (no real dimensions to permute). We
 * collapse it to plain English so stakeholders don't see the literal
 * ``lens: solo`` string.
 */
export function cellDimensionLabel(cell: CellSummary): string {
  const entries = Object.entries(cell.axes);
  if (entries.length === 0) return 'the single defined scenario';
  if (
    entries.length === 1 &&
    entries[0][0] === 'lens' &&
    entries[0][1] === 'solo'
  ) {
    return 'the single defined scenario';
  }
  return entries
    .map(
      ([dimension, value]) =>
        `${dimension.replace(/_/g, ' ')}: ${humaniseValue(value)}`,
    )
    .join(' · ');
}

/**
 * Fallback label when an asset has no recognisable source metadata.
 * The spec from the task: render ``Unlabeled source (run XYZ)`` and
 * link to Dagit, not ``lens·solo``.
 */
export function unlabeledSourceFallback(runId: string): string {
  return `Unlabeled source (run ${runId})`;
}

// ─── Representative cleaner (promoted from /research) ───────────────

/**
 * Trim a spec-curve cluster's representative line down to the body
 * sentence(s) — strip markdown bold/italic, drop the brief's
 * pre-registration / decision-rule trailing sections, collapse
 * whitespace. Used by /research finding cards and /scenario/[id] so
 * the rendered text reads like prose, not the raw markdown the brief
 * stores on disk.
 */
export function cleanRepresentative(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  // Cut off where the brief slips into its pre-registration / decision
  // rule section — that copy belongs on the Setup page, not in a
  // finding or scenario card.
  const cutMatch = trimmed.search(/##\s*Pre-?registration|##\s+/i);
  const sliced = cutMatch >= 0 ? trimmed.slice(0, cutMatch) : trimmed;
  return sliced
    .replace(/\*\*/g, '')
    .replace(/_+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Spec key humanisation ──────────────────────────────────────────

// Per-value display strings for the well-known multiverse dimensions
// in this codebase. Anything outside this map is humanised generically
// (snake_case → "Snake-case").
const SPEC_VALUE_OVERRIDES: Record<string, string> = {
  sub60k: 'Sub-$60k',
  over60k: 'Over-$60k',
  mixed: 'Mixed',
  full_cycle: 'Full-cycle',
  post_inflation: 'Post-inflation',
  demand_space: 'Demand-space',
  colab: 'Co-lab',
  solo: 'Solo',
  nfl_heavy: 'NFL-heavy',
  national: 'National',
  regular: 'Regular',
  playoffs: 'Playoffs',
  tailgate: 'Tailgate',
  gameday: 'Gameday',
};

export export function humaniseValue(value: string): string {
  if (!value) return '';
  const lower = value.toLowerCase();
  if (SPEC_VALUE_OVERRIDES[lower]) return SPEC_VALUE_OVERRIDES[lower];
  return value
    .split('_')
    .filter(Boolean)
    .map((piece) => piece[0].toUpperCase() + piece.slice(1).toLowerCase())
    .join('-');
}

/**
 * Translate a spec-curve cell id (e.g.
 * "demand_space__sub60k__post_inflation") into a plain-language phrase
 * like "Demand-space taxonomy · Sub-$60k cohort · Post-inflation
 * window" using the dimension catalogue on the spec curve cells.
 *
 * Returns the raw key humanised generically when no matching cell can
 * be found — we never echo the raw snake_case tuple back to the user.
 */
export function humanizeSpecKey(
  key: string,
  cells: Array<{ id: string; axes: Record<string, string> }>,
): string {
  if (!key) return '';
  const cell = cells.find((c) => c.id === key);
  if (cell) {
    return Object.entries(cell.axes)
      .map(
        ([dimension, value]) =>
          `${humaniseValue(value)} ${dimension.replace(/_/g, ' ')}`,
      )
      .join(' · ');
  }
  // Fall back: split on '__' (dimension separator) then humanise each
  // value with its underscore-joined pieces.
  return key
    .split('__')
    .filter(Boolean)
    .map((piece) => humaniseValue(piece))
    .join(' · ');
}

/**
 * Lookup helper: given a spec-curve cell, return [dimension, value]
 * pairs in stable order with the dimension name lower-cased (already
 * normalised in the data) and the value humanised. Used by the
 * scenario page's 2-column "Framings inside this scenario" grid.
 */
export function describeCellAxes(
  cell: { axes: Record<string, string> },
): Array<{ dimension: string; value: string; valueDisplay: string }> {
  return Object.entries(cell.axes).map(([dimension, value]) => ({
    dimension,
    value,
    valueDisplay: humaniseValue(value),
  }));
}

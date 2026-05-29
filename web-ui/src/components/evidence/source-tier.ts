/**
 * Source tiering — classify each cited source into a validation tier.
 *
 * Hyde grounds simulation in APPROVED evidence. Diageo-owned sources
 * (internal SQL on the brand's own data, CCF occasion work, BGS brand
 * plans, prior MBPs, prior decisions) come FIRST and are treated as
 * primary; public sources (BLS, TTB, Census, …) ENRICH but are not
 * treated as equivalent. This module is the single, pure classifier
 * that decides which tier a source sits in and what it can / cannot
 * speak to, so the same UI renders the seeded hero study and any live
 * study (whose Diageo-owned tier is simply its internal SQL citations).
 *
 * Pure + framework-free so it can be unit-tested without a React render
 * and reused by both the evidence detail page and the growth-driver
 * evidence chips.
 */

import type { RunCitation } from '@/components/workbench/types';
import { hostFromUrl } from './claim-utils';

export type SourceTier = 'diageo' | 'public';

/**
 * One source's tier classification plus the plain-language scope of
 * what it can and cannot speak to. ``category`` is the internal key the
 * scope copy is looked up from; callers render ``tierLabel``,
 * ``speaksTo`` and ``cantSpeakTo``.
 */
export type TierClassification = {
  tier: SourceTier;
  tierLabel: string; // 'Diageo-owned' | 'Public'
  category: SourceCategory;
  speaksTo: string;
  cantSpeakTo: string;
};

export type SourceCategory =
  | 'internal_sql'
  | 'ccf'
  | 'bgs'
  | 'prior_mbp'
  | 'prior_decision'
  | 'diageo_other'
  | 'bls'
  | 'ttb'
  | 'census'
  | 'fred'
  | 'public_web'
  | 'illustrative';

const DIAGEO_CATEGORIES: ReadonlySet<SourceCategory> = new Set<SourceCategory>([
  'internal_sql',
  'ccf',
  'bgs',
  'prior_mbp',
  'prior_decision',
  'diageo_other',
]);

// Per-category plain-language "speaks to / can't speak to" scope. Kept
// stakeholder-friendly — no slugs, no jargon. The honesty is the point:
// every source is bounded, so the reader sees what it is NOT evidence
// for, not just what it is.
const CATEGORY_SCOPE: Record<
  SourceCategory,
  { label: string; speaksTo: string; cantSpeakTo: string }
> = {
  internal_sql: {
    label: 'Internal data (DuckDB)',
    speaksTo: "Diageo's own depletions, occasion volumes, and brand-level mix.",
    cantSpeakTo: 'competitor volumes or anything outside the measured Diageo panel.',
  },
  ccf: {
    label: 'CCF occasion study',
    speaksTo: 'consumer occasion structure and demand spaces from Diageo CCF work.',
    cantSpeakTo: 'in-market execution or how competitors respond.',
  },
  bgs: {
    label: 'BGS brand plan',
    speaksTo: "the brand's committed strategy and the priorities it was signed against.",
    cantSpeakTo: 'whether the market has moved since the plan was written.',
  },
  prior_mbp: {
    label: 'Prior MBP',
    speaksTo: 'what we planned and assumed in the prior marketing-planning cycle.',
    cantSpeakTo: "this year's competitive shifts or new occasions.",
  },
  prior_decision: {
    label: 'Prior decision',
    speaksTo: 'the assumptions and outcome of an earlier Diageo decision.',
    cantSpeakTo: 'how a different occasion or market behaves now.',
  },
  diageo_other: {
    label: 'Diageo-owned source',
    speaksTo: "Diageo's own research, trackers, or prior IP.",
    cantSpeakTo: 'the wider category or competitor behaviour.',
  },
  bls: {
    label: 'BLS (Bureau of Labor Statistics)',
    speaksTo: 'US consumer price levels and the inflation trend.',
    cantSpeakTo: 'spirits-category volume, brand share, or occasion mix.',
  },
  ttb: {
    label: 'TTB (Alcohol & Tobacco Tax and Trade Bureau)',
    speaksTo: 'US distilled-spirits shipment and removal volumes.',
    cantSpeakTo: 'brand-, occasion-, or market-level detail.',
  },
  census: {
    label: 'US Census Bureau',
    speaksTo: 'US retail-trade aggregates.',
    cantSpeakTo: 'on-premise or occasion-level detail.',
  },
  fred: {
    label: 'FRED (St. Louis Fed)',
    speaksTo: 'US macro and income series.',
    cantSpeakTo: 'spirits demand or brand performance.',
  },
  public_web: {
    label: 'Public web source',
    speaksTo: 'external market context and published commentary.',
    cantSpeakTo: "Diageo's own performance or proprietary occasion data.",
  },
  illustrative: {
    label: 'Illustrative placeholder',
    speaksTo: 'the shape of evidence this driver would need.',
    cantSpeakTo: 'anything load-bearing yet — replace with a real source.',
  },
};

function classification(category: SourceCategory): TierClassification {
  const scope = CATEGORY_SCOPE[category];
  const tier: SourceTier = DIAGEO_CATEGORIES.has(category) ? 'diageo' : 'public';
  return {
    tier,
    tierLabel: tier === 'diageo' ? 'Diageo-owned' : 'Public',
    category,
    speaksTo: scope.speaksTo,
    cantSpeakTo: scope.cantSpeakTo,
  };
}

// Public statistical / data hosts. Mirrors the host catalogue the
// source-label helper already trusts so tiering and labelling agree.
function publicCategoryForHost(host: string): SourceCategory | null {
  if (host.endsWith('bls.gov')) return 'bls';
  if (host.endsWith('ttb.gov')) return 'ttb';
  if (host.endsWith('census.gov')) return 'census';
  if (host.endsWith('bea.gov')) return 'fred';
  if (host.endsWith('stlouisfed.org')) return 'fred';
  // Any other resolvable public host enriches but stays Public.
  return 'public_web';
}

// Diageo-owned artifact markers in a source title / url. These are the
// named internal artifacts the planning graph is grounded on.
function diageoCategoryFromText(text: string): SourceCategory | null {
  const t = text.toLowerCase();
  if (/\bccf\b/.test(t)) return 'ccf';
  if (/\bbgs\b|brand plan|brand-plan/.test(t)) return 'bgs';
  if (/prior[\s-]?mbp|\bmbp\b|prior[\s-]?year plan/.test(t)) return 'prior_mbp';
  if (/prior decision|prior-decision|pilot result|crown peach pilot/.test(t)) {
    return 'prior_decision';
  }
  if (/\bdiageo\b|internal tracker|internal research|first-party/.test(t)) {
    return 'diageo_other';
  }
  return null;
}

/**
 * Classify one final.json citation into a validation tier with scope.
 *
 * Rules (in order):
 *   - ``duckdb`` source  → internal Diageo data (Diageo-owned).
 *   - public host        → Public (BLS / TTB / Census / … ).
 *   - Diageo artifact in the title/url (CCF, BGS, brand plan, MBP,
 *     prior decision, "Diageo")  → Diageo-owned.
 *   - anything else (external web) → Public.
 *
 * This is what makes the layer study-agnostic: a live study's
 * Diageo-owned tier falls out of its ``duckdb`` citations with no
 * named-source special-casing required.
 */
export function classifyCitationTier(c: RunCitation): TierClassification {
  if (c.source === 'duckdb') return classification('internal_sql');

  const host = hostFromUrl(c.url);
  const text = `${c.title ?? ''} ${c.url ?? ''}`.trim();

  // A named Diageo artifact wins over a (possibly internal) host so the
  // seeded "CCF tequila-occasion study 2025" lands in the Diageo tier
  // even if it carries an internal URL.
  const diageo = diageoCategoryFromText(text);
  if (diageo) return classification(diageo);

  if (host) {
    const pub = publicCategoryForHost(host);
    if (pub) return classification(pub);
  }

  return classification('public_web');
}

/**
 * Classify a raw evidence-pointer string (the growth-driver shape, e.g.
 * ``citation:bls:CUUR0000SA0:headline-cpi`` or
 * ``claim:internal-sql:tailgate-occasion-volume-q3-2025``). Used by the
 * growth-driver "What backs it" chips, which carry pointer strings
 * rather than full citations.
 */
export function classifyPointerTier(pointer: string): TierClassification {
  const p = (pointer || '').toLowerCase();
  if (p.includes('internal-sql') || p.includes('internal_sql')) {
    return classification('internal_sql');
  }
  if (p.includes('ccf')) return classification('ccf');
  if (p.includes('bgs') || p.includes('brand-plan')) return classification('bgs');
  if (p.includes('prior-mbp') || /[:\-]mbp[:\-]/.test(p)) {
    return classification('prior_mbp');
  }
  if (p.includes('prior-decision')) return classification('prior_decision');
  if (p.includes(':bls') || p.includes('bls:')) return classification('bls');
  if (p.includes(':ttb') || p.includes('ttb:')) return classification('ttb');
  if (p.includes(':census')) return classification('census');
  if (p.includes(':fred')) return classification('fred');
  if (p.startsWith('demo-placeholder') || p.includes('placeholder')) {
    return classification('illustrative');
  }
  return classification('public_web');
}

export function tierBadgeClass(tier: SourceTier): string {
  return tier === 'diageo'
    ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
    : 'border-slate-200 bg-slate-50 text-slate-600';
}

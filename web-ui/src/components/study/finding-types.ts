import type { ResearchFinding as ApiFinding } from '@/components/workbench/types';

/** UI-facing finding — sourced from GET /studies/{id}/research findings[]. */
export type Finding = {
  id: string;
  rank: number;
  clusterId: number;
  title: string;
  whatsHappening: string;
  whyItMatters: string;
  evidence: string[];
  illustrative: boolean;
  robustness: number;
  nAgree: number;
  nTotal: number;
  fragileSpecs: string[];
  occasion?: string | null;
};

export function findingsFromApi(rows: ApiFinding[]): Finding[] {
  return rows.map((f) => ({
    id: String(f.cluster_id),
    rank: f.rank,
    clusterId: f.cluster_id,
    title: f.answer_title,
    whatsHappening: f.answer_title,
    whyItMatters: f.answer_summary,
    evidence: humaniseSupports(f.source_assets),
    illustrative: f.illustrative,
    robustness: f.robustness,
    nAgree: f.n_agree,
    nTotal: f.n_total,
    fragileSpecs: humaniseFragile(f.fragile_specs),
    occasion: f.occasion,
  }));
}

const SUPPORT_LABELS: Record<string, string> = {
  loyalty: 'Loyalty panel',
  loyalty_panel: 'Loyalty panel',
  occasion_mix: 'Occasion volume share',
  occasion_share: 'Occasion volume share',
  elasticity: 'Price sensitivity',
  elasticity_note: 'Price sensitivity',
  promo: 'Promo holdout',
  promo_holdout: 'Promo holdout',
  brief: 'Research brief',
};

function humaniseSupports(assets: string[]): string[] {
  if (!assets?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of assets.slice(0, 4)) {
    const file = raw.split('/').pop() ?? raw;
    const stem = file.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
    const key = stem.toLowerCase().replace(/\s+/g, '_');
    const label =
      SUPPORT_LABELS[key] ??
      stem
        .split(' ')
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ');
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out.slice(0, 3);
}

function humaniseFragile(specs: string[]): string[] {
  return specs.slice(0, 4).map((s) => s.replace(/__/g, ' / ').replace(/_/g, ' '));
}

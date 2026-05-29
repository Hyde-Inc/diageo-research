export type ConfidenceLevel = 'Low' | 'Medium' | 'High';

export type VariantEffectKind = 'lift' | 'hold' | 'hedge' | 'risk';

export function effectToneClass(kind: VariantEffectKind): string {
  switch (kind) {
    case 'lift':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'hold':
      return 'border-blue-200 bg-blue-50 text-blue-700';
    case 'hedge':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'risk':
      return 'border-orange-200 bg-orange-50 text-orange-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-700';
  }
}

export function confidenceToneClass(level: ConfidenceLevel): string {
  switch (level) {
    case 'High':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'Medium':
      return 'border-yellow-200 bg-yellow-50 text-yellow-700';
    case 'Low':
    default:
      return 'border-orange-200 bg-orange-50 text-orange-700';
  }
}

export function prettify(slug: string): string {
  if (!slug) return '';
  const words = slug
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words.length === 0) return '';
  const SMALL = new Set(['vs', 'and', 'or', 'of', 'the', 'a', 'an', 'in']);
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (lower === 'ap') return 'A&P';
      if (i > 0 && i < words.length - 1 && SMALL.has(lower)) return lower;
      return lower[0].toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

export function effectMagnitude(variant: { effectValue: string }): number {
  const match = variant.effectValue.match(/(-?\d+(?:\.\d+)?)/);
  if (!match) return 0;
  const v = Number(match[1]);
  return Number.isFinite(v) ? v : 0;
}

export function formatDeltaVsBaseline(
  variant: { effectValue: string },
  baseline: { effectValue: string },
): string {
  const a = effectMagnitude(baseline);
  const b = effectMagnitude(variant);
  const delta = b - a;
  if (!Number.isFinite(delta)) return '';
  const tail = baseline.effectValue.replace(/^[+\-]?\d+(\.\d+)?\s*/, '').trim();
  const unit = tail.split(' ')[0] ?? '';
  const sign = delta >= 0 ? '+' : '−';
  const magnitude = Math.abs(delta).toFixed(1);
  return unit
    ? `${sign}${magnitude} ${unit} vs baseline`
    : `${sign}${magnitude} vs baseline`;
}

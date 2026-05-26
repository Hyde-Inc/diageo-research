'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { FocusCard } from '@/components/study/study-shell';
import { cn } from '@/lib/utils';
import { withStudy } from '@/components/study/use-study';
import type { TopRiskCard } from '@/components/workbench/types';

export function TopRiskHero({
  risks,
  studyId,
}: {
  risks: TopRiskCard[];
  studyId: string | null;
}) {
  if (risks.length === 0) return null;
  return (
    <section className="grid gap-3" aria-label="Top occasions at risk">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          Top 3 at risk
        </h2>
        <span className="text-[11px] text-slate-500">
          US tequila · price pressure
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {risks.map((card, idx) => (
          <FocusCard key={card.occasion} className="relative">
            <div className="grid gap-2">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[10px] font-bold tabular-nums text-slate-400">
                  #{idx + 1}
                </span>
                {card.illustrative ? (
                  <Badge
                    variant="outline"
                    className="border-amber-200 bg-amber-50 text-[9px] uppercase tracking-wide text-amber-800"
                  >
                    Illustrative
                  </Badge>
                ) : null}
              </div>
              <h3 className="text-sm font-semibold tracking-tight text-slate-950">
                {card.occasion}
              </h3>
              <p className="text-[12px] leading-snug text-slate-600">
                {card.line}
              </p>
              <RobustnessPill
                score={card.robustness}
                label={card.robustness_label}
              />
              {studyId && card.source_assets.length > 0 ? (
                <Link
                  href={withStudy('/evidence', studyId)}
                  className="text-[11px] font-medium text-slate-700 underline-offset-2 hover:underline"
                >
                  See evidence
                </Link>
              ) : null}
            </div>
          </FocusCard>
        ))}
      </div>
    </section>
  );
}

function RobustnessPill({
  score,
  label,
}: {
  score: number;
  label: string;
}) {
  const tone =
    score >= 0.7
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : score >= 0.4
        ? 'border-yellow-200 bg-yellow-50 text-yellow-700'
        : 'border-orange-200 bg-orange-50 text-orange-700';
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold',
        tone,
      )}
    >
      {label} · {Math.round(score * 100)}%
    </span>
  );
}

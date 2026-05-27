'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { FocusCard } from '@/components/study/study-shell';
import { cn } from '@/lib/utils';
import { withStudy } from '@/components/study/use-study';
import type { TopRiskCard } from '@/components/workbench/types';

/**
 * The Top-3-at-risk hero.
 *
 * Each card carries:
 *   - a specific subject line (the occasion, named explicitly),
 *   - a 1-line "what's happening" + 1-line "why it matters" rewrite of
 *     the model's prose so the wall-of-text never blocks the answer,
 *   - up to three "what supports it" chips drawn from the card's
 *     evidence asset list (human label, not raw key),
 *   - an explicit holds-in-N-of-M confidence pill paired with a tiny
 *     bar, and
 *   - a "see evidence" link that keeps study context.
 *
 * Long descriptions get a "show more" affordance so we never end mid-
 * sentence on three-line truncation.
 */
export function TopRiskHero({
  risks,
  studyId,
  scenarioTotal,
}: {
  risks: TopRiskCard[];
  studyId: string | null;
  scenarioTotal: number;
}) {
  if (risks.length === 0) return null;
  return (
    <section className="grid gap-3" aria-label="Subjects most at risk">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            Top 3 at risk in this study
          </h2>
          <p className="mt-1 text-[12px] leading-snug text-slate-500">
            The three subjects most exposed to the current question. Each
            card spells out what&apos;s happening, why it matters, and what
            supports it.
          </p>
        </div>
        <span className="text-[11px] text-slate-500">
          Ranked by exposure across {scenarioTotal || risks.length}{' '}
          {scenarioTotal === 1 ? 'scenario' : 'scenarios'}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {risks.map((card, idx) => (
          <RiskCard
            key={card.occasion}
            card={card}
            studyId={studyId}
            index={idx}
            scenarioTotal={scenarioTotal}
          />
        ))}
      </div>
    </section>
  );
}

function RiskCard({
  card,
  studyId,
  index,
  scenarioTotal,
}: {
  card: TopRiskCard;
  studyId: string | null;
  index: number;
  scenarioTotal: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const { headline, happening, mattersBecause } = parseLine(card.line, card.occasion);
  const supports = humaniseSupports(card.source_assets);
  const longBody = happening.length + mattersBecause.length > 220;

  return (
    <FocusCard className="relative">
      <div className="grid gap-2">
        <div className="flex items-start justify-between gap-2">
          <span className="text-[10px] font-bold tabular-nums text-slate-400">
            #{index + 1}
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
        <h3 className="text-balance text-sm font-semibold tracking-tight text-slate-950">
          {headline}
        </h3>
        <dl className="grid gap-1.5 text-[12px] leading-snug">
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              What&apos;s happening
            </dt>
            <dd className="text-slate-700">
              {longBody && !expanded
                ? `${trimToBoundary(happening, 140)}…`
                : happening}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Why it matters
            </dt>
            <dd className="text-slate-700">{mattersBecause}</dd>
          </div>
        </dl>
        {longBody ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-fit text-[11px] font-medium text-slate-700 underline-offset-2 hover:underline"
          >
            {expanded ? 'Show less' : 'See more'}
          </button>
        ) : null}
        {supports.length > 0 ? (
          <div className="grid gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              What supports it
            </span>
            <ul className="flex flex-wrap gap-1">
              {supports.map((label) => (
                <li
                  key={label}
                  className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-700"
                >
                  {label}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <ConfidenceMeter
          score={card.robustness}
          scenarioTotal={scenarioTotal}
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
  );
}

function ConfidenceMeter({
  score,
  scenarioTotal,
}: {
  score: number;
  scenarioTotal: number;
}) {
  const hasScenarios = scenarioTotal > 0;
  const holds = hasScenarios ? Math.round(score * scenarioTotal) : 0;
  const pct = Math.round(score * 100);
  const tone =
    score >= 0.7
      ? {
          pill: 'border-emerald-200 bg-emerald-50 text-emerald-700',
          bar: 'bg-emerald-500',
        }
      : score >= 0.4
        ? {
            pill: 'border-yellow-200 bg-yellow-50 text-yellow-700',
            bar: 'bg-yellow-500',
          }
        : {
            pill: 'border-orange-200 bg-orange-50 text-orange-700',
            bar: 'bg-orange-500',
          };
  const phrasing = hasScenarios
    ? scenarioTotal === 1
      ? holds >= 1
        ? 'Holds in 1 of 1 scenario'
        : 'Does not hold in this single scenario'
      : score < 0.5 && score > 0
        ? `Limited support — only ${holds} of ${scenarioTotal} framings agree`
        : `Holds in ${holds} of ${scenarioTotal} scenarios`
    : 'Confidence not yet computed — scenarios are still running';

  return (
    <div className="grid gap-1">
      <span
        className={cn(
          'inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold',
          tone.pill,
        )}
      >
        {phrasing}
      </span>
      {hasScenarios ? (
        <div className="h-1 w-full overflow-hidden rounded-full bg-slate-100">
          <div className={cn('h-full', tone.bar)} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
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
  if (!assets || assets.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of assets.slice(0, 4)) {
    const file = raw.split('/').pop() ?? raw;
    const stem = file
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();
    const key = stem.toLowerCase().replace(/\s+/g, '_');
    const label =
      SUPPORT_LABELS[key] ?? toTitleCase(stem) ?? 'Research evidence';
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out.slice(0, 3);
}

function toTitleCase(value: string): string {
  if (!value) return '';
  return value
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function parseLine(
  line: string,
  fallback: string,
): { headline: string; happening: string; mattersBecause: string } {
  const text = (line ?? '').trim();
  if (!text) {
    return {
      headline: fallback,
      happening: 'No description from the brief yet.',
      mattersBecause: 'Why this matters has not been written up yet.',
    };
  }
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) {
    return {
      headline: fallback,
      happening: text,
      mattersBecause: 'Why it matters: pending confirmation from the brief.',
    };
  }
  const headline = subjectHeadline(sentences[0], fallback);
  const happening = sentences[0];
  let mattersBecause = sentences.slice(1).join(' ').trim();
  if (!mattersBecause) {
    mattersBecause =
      'Carries enough volume or visibility to move the headline answer if it breaks.';
  }
  return { headline, happening, mattersBecause };
}

function subjectHeadline(first: string, fallback: string): string {
  const trimmed = first.trim();
  if (!trimmed) return fallback;
  const candidate = trimmed.split(/[,;:]\s+/)[0];
  const cleaned = candidate.replace(/[.!?]+$/, '').trim();
  if (cleaned.length === 0 || cleaned.length > 72) return fallback;
  return cleaned;
}

function trimToBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return lastSpace > 40 ? slice.slice(0, lastSpace) : slice;
}

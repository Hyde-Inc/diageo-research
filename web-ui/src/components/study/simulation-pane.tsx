'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { PaneCard } from '@/components/workbench/pane-layout';
import { cn } from '@/lib/utils';
import { withStudy } from '@/components/study/use-study';
import type { SpecCurve } from '@/components/workbench/types';

export type SimulationPrefs = {
  discountPct: number;
  mode: 'discount' | 'bundling';
  occasion: string;
};

export function SimulationPane({
  studyId,
  curve,
  topOccasion,
  prefs,
  onTraceChip,
}: {
  studyId: string | null;
  curve: SpecCurve | null;
  topOccasion: string;
  prefs: SimulationPrefs;
  onTraceChip: (traceId: string, label: string) => void;
}) {
  const lead = curve?.rows[0];
  const robustness = lead?.robustness ?? 0.55;

  const outcome = useMemo(() => {
    const discountLift = prefs.discountPct * 0.9;
    const bundleLift = prefs.discountPct * 0.72 + 4;
    const winner =
      bundleLift > discountLift ? ('bundling' as const) : ('discount' as const);
    const margin = Math.abs(bundleLift - discountLift);
    const confidence =
      robustness >= 0.65 && margin >= 3
        ? 'High'
        : robustness >= 0.4
          ? 'Medium'
          : 'Low';
    return { discountLift, bundleLift, winner, margin, confidence };
  }, [prefs.discountPct, robustness]);

  return (
    <div className="grid gap-4">
      <Badge
        variant="outline"
        className="w-fit border-amber-300 bg-amber-50 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-900"
      >
        Illustrative — not for action without validation
      </Badge>

      <p className="text-sm text-slate-600">
        For consumers in <strong>{topOccasion}</strong>, does a{' '}
        {prefs.discountPct}% discount or bundling preserve Don Julio spend
        better?
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <OutcomeCard
          title="Discount"
          subtitle={`${prefs.discountPct}% off shelf price`}
          value={`+${outcome.discountLift.toFixed(1)}pp`}
          detail="Estimated Don Julio spend retention vs baseline."
          winner={outcome.winner === 'discount'}
          chips={[
            {
              label: 'Loyalty indicator',
              asset: 'runs/loyalty_panel.csv',
              traceId: 'loyalty',
            },
            {
              label: 'Price sensitivity',
              asset: 'runs/elasticity_note.md',
              traceId: 'elasticity',
            },
          ]}
          onTraceChip={onTraceChip}
        />
        <OutcomeCard
          title="Bundling"
          subtitle="Mixer + serve bundle"
          value={`+${outcome.bundleLift.toFixed(1)}pp`}
          detail="Estimated Don Julio spend retention vs baseline."
          winner={outcome.winner === 'bundling'}
          chips={[
            {
              label: 'Occasion volume share',
              asset: 'runs/occasion_mix.json',
              traceId: 'occasion_share',
            },
            {
              label: 'Price sensitivity',
              asset: 'runs/elasticity_note.md',
              traceId: 'elasticity',
            },
          ]}
          onTraceChip={onTraceChip}
        />
      </div>

      <PaneCard
        title="Readout"
        meta={`Self-confidence · ${outcome.confidence}`}
        description="Mock-but-grounded comparison for the Wednesday demo."
      >
        <p className="text-sm font-medium text-slate-900">
          {outcome.winner === 'bundling' ? 'Bundling' : 'Discount'} wins by{' '}
          {outcome.margin.toFixed(1)} percentage points on modeled spend
          retention.
        </p>
        <ConfidencePill level={outcome.confidence} />
        <p className="mt-2 text-[12px] text-slate-600">
          {outcome.confidence === 'High'
            ? 'Validate with a holdout promo cell before scaling.'
            : outcome.confidence === 'Medium'
              ? 'Run one more scenario cut on cohort before recommending.'
              : 'Treat as directional only — scenarios still disagree.'}
        </p>
        {studyId ? (
          <Link
            href={withStudy('/research', studyId)}
            className="mt-2 inline-block text-[12px] font-medium text-slate-800 underline-offset-2 hover:underline"
          >
            Back to research brief
          </Link>
        ) : null}
      </PaneCard>
    </div>
  );
}

function OutcomeCard({
  title,
  subtitle,
  value,
  detail,
  winner,
  chips,
  onTraceChip,
}: {
  title: string;
  subtitle: string;
  value: string;
  detail: string;
  winner: boolean;
  chips: Array<{ label: string; asset: string; traceId: string }>;
  onTraceChip: (id: string, label: string) => void;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border bg-white p-4 shadow-sm',
        winner
          ? 'border-emerald-300 ring-2 ring-emerald-100'
          : 'border-slate-200',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <p className="text-[11px] text-slate-500">{subtitle}</p>
        </div>
        {winner ? (
          <Badge className="bg-emerald-600 text-[10px] uppercase">Winner</Badge>
        ) : null}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-950">
        {value}
      </p>
      <p className="mt-1 text-[12px] text-slate-600">{detail}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <button
            key={c.traceId}
            type="button"
            onClick={() => onTraceChip(c.traceId, c.label)}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-700 hover:border-slate-400"
            title={c.asset}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConfidencePill({ level }: { level: string }) {
  const tone =
    level === 'High'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : level === 'Medium'
        ? 'border-yellow-200 bg-yellow-50 text-yellow-800'
        : 'border-orange-200 bg-orange-50 text-orange-800';
  return (
    <span
      className={cn(
        'mt-2 inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-semibold',
        tone,
      )}
    >
      Confidence · {level}
    </span>
  );
}

export function simulationPromptChips(
  studyId: string | null,
  topOccasion: string,
): Array<{ label: string; href: string }> {
  const base = withStudy('/simulation', studyId, {
    occasion: topOccasion,
  });
  return [
    {
      label: '15% discount vs bundling',
      href: `${base}&discount=15&mode=compare`,
    },
    {
      label: '20% discount only',
      href: `${base}&discount=20&mode=discount`,
    },
    {
      label: 'Bundle + serve',
      href: `${base}&discount=15&mode=bundling`,
    },
    {
      label: 'Sub-$60k cohort cut',
      href: `${base}&discount=15&mode=compare&cohort=sub60k`,
    },
  ];
}

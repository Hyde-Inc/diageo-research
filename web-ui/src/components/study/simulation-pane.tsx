'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { ConfidencePanel } from '@/components/study/confidence-panel';
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
  const outcome = useMemo(() => {
    const discountLift = prefs.discountPct * 0.9;
    const bundleLift = prefs.discountPct * 0.72 + 4;
    const winner =
      bundleLift > discountLift ? ('bundling' as const) : ('discount' as const);
    const margin = Math.abs(bundleLift - discountLift);
    return { discountLift, bundleLift, winner, margin };
  }, [prefs.discountPct]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className="w-fit border-amber-300 bg-amber-50 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-900"
        >
          Illustrative — not for action without validation
        </Badge>
        <Badge
          variant="outline"
          className="w-fit border-orange-200 bg-orange-50 text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-700"
        >
          Self-confidence: low — model has no connected promo data yet
        </Badge>
      </div>

      <p className="text-sm text-slate-600">
        In <strong>{topOccasion}</strong>, the most exposed occasion in this
        study, does a {prefs.discountPct}% discount or a mixer-and-serve
        bundle better preserve Don Julio spend?
      </p>

      <div className="grid gap-3 md:grid-cols-3">
        <InputBlock
          title="Evidence inputs (real sources)"
          items={[
            'Loyalty: loyalty panel cohort flows (loyalty_panel.csv).',
            'Sensitivity: brand-level elasticity note (elasticity_note.md).',
            'Occasion mix: weekly occasion shares (occasion_mix.json).',
          ]}
        />
        <InputBlock
          title="Assumptions (illustrative)"
          items={[
            `${prefs.discountPct}% discount uses an illustrative retention multiplier, not an observed promo lift.`,
            'Bundling assumes mixer + serve value protects premium spend better than a straight discount.',
            'No connected promo holdout data yet, so the interval estimate is a placeholder.',
          ]}
        />
        <InputBlock
          title="What we'd need to validate"
          items={[
            'A reserved Don Julio promo holdout for this occasion to estimate a real lift.',
            'Sub-$60k household, Hispanic audience, and on-premise cuts to test sensitivity.',
            'A backtest against past Don Julio promo scenarios in the same window.',
          ]}
        />
      </div>

      <div className="grid gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Simulated output
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <OutcomeCard
            title="Discount"
            subtitle={`${prefs.discountPct}% off the shelf price`}
            value={`+${outcome.discountLift.toFixed(1)} pp`}
            valueLabel="Illustrative spend retention vs baseline (percentage points)"
            detail="Illustrative Don Julio spend retention vs baseline."
            winner={outcome.winner === 'discount'}
            chips={[
              {
                label: 'Loyalty: loyalty panel',
                asset: 'runs/loyalty_panel.csv',
                traceId: 'loyalty',
              },
              {
                label: 'Sensitivity: elasticity note',
                asset: 'runs/elasticity_note.md',
                traceId: 'elasticity',
              },
            ]}
            onTraceChip={onTraceChip}
          />
          <OutcomeCard
            title="Bundling"
            subtitle="Mixer + serve bundle"
            value={`+${outcome.bundleLift.toFixed(1)} pp`}
            valueLabel="Illustrative spend retention vs baseline (percentage points)"
            detail="Illustrative Don Julio spend retention vs baseline."
            winner={outcome.winner === 'bundling'}
            chips={[
              {
                label: 'Occasion mix: weekly shares',
                asset: 'runs/occasion_mix.json',
                traceId: 'occasion_share',
              },
              {
                label: 'Sensitivity: elasticity note',
                asset: 'runs/elasticity_note.md',
                traceId: 'elasticity',
              },
            ]}
            onTraceChip={onTraceChip}
          />
        </div>
      </div>

      <PaneCard
        title="Readout"
        meta="Illustrative model output"
        description="Side-by-side comparison from the illustrative model. Not decision-grade until validated against promo data."
      >
        <p className="text-sm font-medium text-slate-900">
          {outcome.winner === 'bundling' ? 'Bundling' : 'Discount'} wins by{' '}
          {outcome.margin.toFixed(1)} percentage points on illustrative spend
          retention.
        </p>
        <p className="mt-2 text-[12px] text-slate-600">
          Prediction interval: not yet estimated. To estimate one honestly we
          would need connected Don Julio promo or holdout outcomes for this
          occasion.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {studyId ? (
            <Link
              href={withStudy('/why-it-could-be-wrong', studyId)}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-slate-950 px-4 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
            >
              Validate against promo data
            </Link>
          ) : null}
          {studyId ? (
            <Link
              href={withStudy('/research', studyId)}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              Back to research brief
            </Link>
          ) : null}
        </div>
      </PaneCard>

      <ConfidencePanel
        curve={curve}
        interval={{
          kind: 'prediction interval',
          available: false,
          requiredData:
            'connected Don Julio promo, loyalty, and holdout outcome observations for this occasion.',
        }}
        provenance={{
          source: 'Research brief traces plus simulation settings',
          transformation: 'Illustrative discount and bundling retention model',
          output: 'Side-by-side simulated spend retention readout',
          available: true,
        }}
        raiseConfidence={[
          'Connect promo data and estimate a real prediction interval for spend retention.',
          'Run a holdout or backtest for discount and bundle cells in the exposed occasion.',
          'Cut sensitivity by sub60k, Hispanic audience, and on-premise once those segment fields are connected.',
        ]}
      />
    </div>
  );
}

function InputBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-[12px] font-semibold text-slate-900">{title}</h3>
      <ul className="mt-2 grid gap-1.5 text-[12px] leading-snug text-slate-600">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OutcomeCard({
  title,
  subtitle,
  value,
  valueLabel,
  detail,
  winner,
  chips,
  onTraceChip,
}: {
  title: string;
  subtitle: string;
  value: string;
  valueLabel?: string;
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
      {valueLabel ? (
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          {valueLabel}
        </p>
      ) : null}
      <p className="mt-1 text-[12px] text-slate-600">{detail}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <button
            key={c.traceId}
            type="button"
            onClick={() => onTraceChip(c.traceId, c.label)}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-700 hover:border-slate-400"
            title={`Source: ${c.asset}`}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
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
      label: 'Compare a 15% discount vs a bundle',
      href: `${base}&discount=15&mode=compare`,
    },
    {
      label: 'Test a 20% discount on its own',
      href: `${base}&discount=20&mode=discount`,
    },
    {
      label: 'Test a mixer + serve bundle',
      href: `${base}&discount=15&mode=bundling`,
    },
    {
      label: 'Narrow to sub-$60k households',
      href: `${base}&discount=15&mode=compare&cohort=sub60k`,
    },
  ];
}

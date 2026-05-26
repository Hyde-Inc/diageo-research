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
      <Badge
        variant="outline"
        className="w-fit border-amber-300 bg-amber-50 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-900"
      >
        Illustrative — not for action without validation
      </Badge>

      <p className="text-sm text-slate-600">
        Closed question: in <strong>{topOccasion}</strong>, the most exposed
        occasion, does a {prefs.discountPct}% discount or bundling better
        preserve Don Julio spend?
      </p>

      <div className="grid gap-3 md:grid-cols-3">
        <InputBlock
          title="Evidence inputs"
          items={[
            'Occasion risk and spend-pressure signals from the current research brief.',
            'Clickable traces for loyalty, price sensitivity, and occasion mix.',
            'Current spec curve agreement, if the study has finished running.',
          ]}
        />
        <InputBlock
          title="Assumptions"
          items={[
            `${prefs.discountPct}% discount uses an illustrative retention multiplier, not observed promo lift.`,
            'Bundling assumes mixer + serve value protects premium spend better than a straight discount.',
            'No connected promo holdout data yet, so interval estimates are placeholders.',
          ]}
        />
        <InputBlock
          title="Validate next"
          items={[
            'Validate with promo data before scaling the recommendation.',
            'Reserve a holdout or backtest against past Don Julio promo cells.',
            'Could cut by sub60k, Hispanic audience, or on-premise once data is connected.',
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
            subtitle={`${prefs.discountPct}% off shelf price`}
            value={`+${outcome.discountLift.toFixed(1)}pp`}
            detail="Illustrative Don Julio spend retention vs baseline."
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
            detail="Illustrative Don Julio spend retention vs baseline."
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
      </div>

      <PaneCard
        title="Readout"
        meta="Illustrative model output"
        description="Mock-grounded comparison for the Wednesday demo; not decision-grade until validated."
      >
        <p className="text-sm font-medium text-slate-900">
          {outcome.winner === 'bundling' ? 'Bundling' : 'Discount'} wins by{' '}
          {outcome.margin.toFixed(1)} percentage points on modeled spend
          retention.
        </p>
        <p className="mt-2 text-[12px] text-slate-600">
          Prediction interval: not yet estimated. Required data: connected promo
          or holdout observations for Don Julio spend retention in this
          occasion.
        </p>
        <p className="mt-2 text-[12px] font-medium text-slate-800">
          CTA: validate with promo data before recommending discount or bundle
          spend shifts.
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

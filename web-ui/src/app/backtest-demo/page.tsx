'use client';

/**
 * /backtest-demo — illustrative empirical-backtest concept.
 *
 * The live [data-validation="backtest"] panel on /decision/[id] is honest
 * about the fact that no closed-outcome data exists yet, so it shows a
 * "method-ready · outcome data pending" card. This page is a slide-ready
 * MOCK of what that panel becomes once real outcomes land: Hyde replayed
 * BLIND against several baseline models on past decisions whose realized
 * outcomes are known.
 *
 * Everything here is hardcoded illustrative data (ILLUSTRATIVE_BACKTEST).
 * It touches no validation logic, no live panel, and no seed data. The
 * page is marked visibly as an illustrative concept so no one mistakes
 * the numbers for validated results — that honesty is the whole point.
 */

import Link from 'next/link';
import { ArrowLeft, Check, FlaskConical, Gauge, X } from 'lucide-react';
import { FocusCard } from '@/components/study/study-shell';
import { cn } from '@/lib/utils';

type Verdict = 'hit' | 'miss';

type ModelKey = 'hyde' | 'ungrounded' | 'survey' | 'naive';

type ModelMeta = {
  key: ModelKey;
  name: string;
  blurb: string;
  hits: number;
  /** Hyde gets the dark accent panel so it reads as the lead model. */
  lead?: boolean;
};

type DecisionRow = {
  id: string;
  brand: string;
  occasion: string;
  realized: string;
  calls: Record<ModelKey, { verdict: Verdict; call: string }>;
};

// ── Illustrative methodology data — NOT validated results ──────────────
// Hand-authored so the pattern is believable: Hyde leads but is not
// perfect (7/9, two honest misses), baselines trail and vary, and the
// last row is a miss for every model (the genuinely crowded bet).
const ILLUSTRATIVE_BACKTEST = {
  reserved: 9,
  window: 'FY24 → FY25 realized window',
  models: [
    {
      key: 'hyde',
      name: 'Hyde',
      blurb: 'Grounded simulation',
      hits: 7,
      lead: true,
    },
    {
      key: 'ungrounded',
      name: 'Ungrounded LLM panel',
      blurb: 'Generic synthetic consumers',
      hits: 4,
    },
    {
      key: 'survey',
      name: 'Survey-only baseline',
      blurb: 'Stated-intent survey read',
      hits: 5,
    },
    {
      key: 'naive',
      name: 'Naive carry-forward',
      blurb: 'Last-year actuals repeated',
      hits: 3,
    },
  ] satisfies ModelMeta[],
  decisions: [
    {
      id: 'cr-nfl',
      brand: 'Crown Royal',
      occasion: 'NFL tailgate',
      realized: 'Tailgate over-indexed; Regal Apple +12% volume',
      calls: {
        hyde: { verdict: 'hit', call: 'Lead Regal Apple' },
        ungrounded: { verdict: 'hit', call: 'Lead Regal Apple' },
        survey: { verdict: 'hit', call: 'Lead Regal Apple' },
        naive: { verdict: 'miss', call: 'Hold flat' },
      },
    },
    {
      id: 'dj-cinco',
      brand: 'Don Julio',
      occasion: 'Cinco de Mayo',
      realized: 'Shoppers traded down; Blanco carried, 1942 flat',
      calls: {
        hyde: { verdict: 'hit', call: 'Lead Blanco' },
        ungrounded: { verdict: 'miss', call: 'Push 1942' },
        survey: { verdict: 'hit', call: 'Lead Blanco' },
        naive: { verdict: 'hit', call: 'Lead Blanco' },
      },
    },
    {
      id: 'gn-stpat',
      brand: 'Guinness',
      occasion: "St. Patrick's Day",
      realized: 'Draught surged; 0.0 non-alc beat plan',
      calls: {
        hyde: { verdict: 'hit', call: 'Back 0.0 line' },
        ungrounded: { verdict: 'hit', call: 'Back 0.0 line' },
        survey: { verdict: 'miss', call: 'Draught only' },
        naive: { verdict: 'hit', call: 'Back 0.0 line' },
      },
    },
    {
      id: 'jw-gift',
      brand: 'Johnnie Walker',
      occasion: 'Holiday gifting',
      realized: 'Blue Label gifting up; mid-tier flat',
      calls: {
        hyde: { verdict: 'hit', call: 'Lead Blue Label' },
        ungrounded: { verdict: 'miss', call: 'Lead Red value' },
        survey: { verdict: 'hit', call: 'Lead Blue Label' },
        naive: { verdict: 'miss', call: 'Lead Red value' },
      },
    },
    {
      id: 'cm-rooftop',
      brand: 'Casamigos',
      occasion: 'Summer rooftop',
      realized: 'Occasion expanded; took share from Patrón',
      calls: {
        hyde: { verdict: 'hit', call: 'Expand activation' },
        ungrounded: { verdict: 'hit', call: 'Expand activation' },
        survey: { verdict: 'miss', call: 'Hold, saturated' },
        naive: { verdict: 'miss', call: 'Hold flat' },
      },
    },
    {
      id: 'cap-gameday',
      brand: 'Captain Morgan',
      occasion: 'Game day',
      realized: 'Spiced-rum occasion declined; shifted to whiskey',
      calls: {
        hyde: { verdict: 'miss', call: 'Back spiced push' },
        ungrounded: { verdict: 'miss', call: 'Back spiced push' },
        survey: { verdict: 'hit', call: 'Pull back' },
        naive: { verdict: 'miss', call: 'Back spiced push' },
      },
    },
    {
      id: 'tan-spring',
      brand: 'Tanqueray',
      occasion: 'Spring cocktails',
      realized: 'Gin occasion soft; premium Sevilla held',
      calls: {
        hyde: { verdict: 'hit', call: 'Focus Sevilla' },
        ungrounded: { verdict: 'miss', call: 'Push core' },
        survey: { verdict: 'miss', call: 'Push core' },
        naive: { verdict: 'miss', call: 'Push core' },
      },
    },
    {
      id: 'bly-winter',
      brand: 'Baileys',
      occasion: 'Winter holidays',
      realized: 'Dessert occasion strong; Baileys +9%',
      calls: {
        hyde: { verdict: 'hit', call: 'Back holiday push' },
        ungrounded: { verdict: 'hit', call: 'Back holiday push' },
        survey: { verdict: 'hit', call: 'Back holiday push' },
        naive: { verdict: 'hit', call: 'Back holiday push' },
      },
    },
    {
      id: 'bul-bbq',
      brand: 'Bulleit',
      occasion: 'Craft BBQ',
      realized: 'Occasion crowded; lost share to local craft',
      calls: {
        hyde: { verdict: 'miss', call: 'Back BBQ push' },
        ungrounded: { verdict: 'miss', call: 'Back BBQ push' },
        survey: { verdict: 'miss', call: 'Back BBQ push' },
        naive: { verdict: 'miss', call: 'Back BBQ push' },
      },
    },
  ] satisfies DecisionRow[],
};

const COL_TEMPLATE =
  'grid-cols-[minmax(150px,1.1fr)_minmax(190px,1.4fr)_repeat(4,minmax(116px,0.9fr))]';

export default function BacktestDemoPage() {
  const { models, decisions, reserved, window } = ILLUSTRATIVE_BACKTEST;
  return (
    <div className="min-h-svh bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.10),transparent_32rem),linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)] pb-16 font-sans text-slate-950">
      <header className="border-b border-slate-200/80 bg-white/80 px-4 py-4 shadow-sm shadow-slate-950/[0.03] backdrop-blur sm:px-6">
        <div className="mx-auto flex w-full max-w-[1500px] flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <Link
              href="/"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 transition-colors hover:text-slate-900"
            >
              <ArrowLeft className="h-3 w-3" />
              Workbench
            </Link>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              <FlaskConical className="h-3 w-3" />
              Empirical backtest · illustrative concept
            </div>
            <h1 className="mt-1 text-balance text-xl font-semibold leading-snug tracking-tight text-slate-950 sm:text-2xl">
              Would Hyde have called these right?
            </h1>
            <p className="mt-1 max-w-3xl text-[12px] leading-snug text-slate-500">
              Each committed snapshot is replayed{' '}
              <span className="font-semibold text-slate-700">blind</span>{' '}
              against the realized window and scored without seeing the
              outcome — Hyde alongside three baseline models, on past Diageo
              occasion bets whose results are now known.
            </p>
          </div>
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
            Illustrative concept — hypothetical models
          </span>
        </div>
      </header>

      <main className="px-4 py-6 sm:px-6">
        <div className="mx-auto grid w-full max-w-[1500px] gap-4">
          {/* Honest framing marker */}
          <div className="rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-[12px] leading-snug text-amber-900 shadow-sm">
            <span className="font-semibold">Illustrative concept.</span>{' '}
            Methodology shown on hypothetical models and example outcomes —
            live studies await closed-outcome data. These are not validated
            results; they show the shape of the scorecard the live backtest
            produces once realized actuals land.
          </div>

          {/* Per-model hit-rate summary */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {models.map((m) => (
              <ModelSummaryCard key={m.key} model={m} total={reserved} />
            ))}
          </div>

          {/* Calibration + blind-replay note */}
          <FocusCard className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex items-start gap-3">
              <Gauge className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Calibration check — Hyde
                </div>
                <p className="mt-1 text-[13px] leading-snug text-slate-700">
                  Stated <span className="font-semibold">72%</span> mean
                  confidence across these {reserved} calls; realized accuracy{' '}
                  <span className="font-semibold">78%</span> (7/9). Slightly
                  under-confident — well-calibrated in the conservative
                  direction.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 sm:border-l sm:border-slate-200 sm:pl-4">
              <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Blind replay
                </div>
                <p className="mt-1 text-[13px] leading-snug text-slate-700">
                  The committed snapshot is replayed against the{' '}
                  {window} and scored without the model seeing the realized
                  outcome — same reserved set for every model, so the
                  comparison is apples-to-apples.
                </p>
              </div>
            </div>
          </FocusCard>

          {/* Comparison matrix */}
          <FocusCard className="overflow-x-auto p-0">
            <div className="min-w-[920px]">
              {/* Header row */}
              <div
                className={cn(
                  'grid items-end gap-px border-b border-slate-200 bg-slate-50/70 px-4 pb-2 pt-4',
                  COL_TEMPLATE,
                )}
              >
                <ColHead label="Past decision" />
                <ColHead label="What actually happened" />
                {models.map((m) => (
                  <div key={m.key} className="px-2 text-center">
                    <div
                      className={cn(
                        'text-[11px] font-semibold leading-tight',
                        m.lead ? 'text-slate-950' : 'text-slate-700',
                      )}
                    >
                      {m.name}
                    </div>
                    <div className="mt-0.5 text-[9px] uppercase tracking-wide text-slate-400">
                      {m.blurb}
                    </div>
                  </div>
                ))}
              </div>

              {/* Decision rows */}
              {decisions.map((row, i) => (
                <div
                  key={row.id}
                  className={cn(
                    'grid items-stretch gap-px px-4 py-3',
                    i % 2 === 1 ? 'bg-slate-50/40' : 'bg-white',
                    COL_TEMPLATE,
                  )}
                >
                  <div className="pr-2">
                    <div className="text-[13px] font-semibold leading-tight tracking-tight text-slate-950">
                      {row.brand}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {row.occasion}
                    </div>
                  </div>
                  <div className="pr-2 text-[12px] leading-snug text-slate-600">
                    {row.realized}
                  </div>
                  {models.map((m) => (
                    <VerdictCell
                      key={m.key}
                      verdict={row.calls[m.key].verdict}
                      call={row.calls[m.key].call}
                      lead={m.lead}
                    />
                  ))}
                </div>
              ))}

              {/* Footer hit-rate row */}
              <div
                className={cn(
                  'grid items-center gap-px border-t border-slate-200 bg-slate-50/70 px-4 py-3',
                  COL_TEMPLATE,
                )}
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Hit-rate
                </div>
                <div />
                {models.map((m) => (
                  <div key={m.key} className="text-center">
                    <span
                      className={cn(
                        'text-[15px] font-semibold tabular-nums',
                        m.lead ? 'text-emerald-600' : 'text-slate-700',
                      )}
                    >
                      {m.hits}/{reserved}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </FocusCard>

          <p className="text-[11px] leading-snug text-slate-500">
            Verdict colors match the workbench: emerald = hit, red = miss.
            Green/red is scored vs. the realized outcome, not vs. each other.
            To make this a live validated view, the reserved blind window
            needs its closed-outcome actuals — until those land, the live{' '}
            <span className="font-mono text-[10px]">backtest</span> panel
            stays method-ready, not validated.
          </p>
        </div>
      </main>
    </div>
  );
}

function ColHead({ label }: { label: string }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
      {label}
    </div>
  );
}

function ModelSummaryCard({
  model,
  total,
}: {
  model: ModelMeta;
  total: number;
}) {
  const pct = Math.round((model.hits / total) * 100);
  return (
    <section
      className={cn(
        'grid gap-2 rounded-3xl border p-4 shadow-sm shadow-slate-950/[0.04]',
        model.lead
          ? 'border-slate-900 bg-slate-950 text-slate-50'
          : 'border-slate-200 bg-white/95',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div
            className={cn(
              'text-[13px] font-semibold leading-tight tracking-tight',
              model.lead ? 'text-white' : 'text-slate-950',
            )}
          >
            {model.name}
          </div>
          <div
            className={cn(
              'mt-0.5 text-[11px] leading-snug',
              model.lead ? 'text-slate-300' : 'text-slate-500',
            )}
          >
            {model.blurb}
          </div>
        </div>
        {model.lead ? (
          <span className="inline-flex shrink-0 items-center rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
            Lead
          </span>
        ) : null}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span
          className={cn(
            'text-2xl font-semibold tabular-nums',
            model.lead ? 'text-emerald-400' : 'text-slate-900',
          )}
        >
          {model.hits}/{total}
        </span>
        <span
          className={cn(
            'text-[11px] font-medium tabular-nums',
            model.lead ? 'text-slate-400' : 'text-slate-500',
          )}
        >
          {pct}% hit-rate
        </span>
      </div>
      <div
        className={cn(
          'h-1.5 w-full overflow-hidden rounded-full',
          model.lead ? 'bg-slate-800' : 'bg-slate-100',
        )}
      >
        <div
          className={cn(
            'h-full rounded-full',
            model.lead ? 'bg-emerald-400' : 'bg-slate-400',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </section>
  );
}

function VerdictCell({
  verdict,
  call,
  lead,
}: {
  verdict: Verdict;
  call: string;
  lead?: boolean;
}) {
  const hit = verdict === 'hit';
  return (
    <div className="flex flex-col items-center gap-1 px-1 text-center">
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
          hit
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-rose-200 bg-rose-50 text-rose-700',
          lead && hit && 'border-emerald-300 ring-1 ring-emerald-200',
        )}
      >
        {hit ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
        {hit ? 'Hit' : 'Miss'}
      </span>
      <span className="text-[10px] leading-tight text-slate-500">{call}</span>
    </div>
  );
}

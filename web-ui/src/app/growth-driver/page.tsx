'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Compass,
  FileSearch,
  HelpCircle,
  MessageCircle,
  Play,
  Sparkles,
  Target,
} from 'lucide-react';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type Quarter = 'Q1' | 'Q2' | 'Q3' | 'Q4';

type QuarterActivity = {
  quarter: Quarter;
  label: string;
  emphasis: 'launch' | 'sustain' | 'pulse';
};

type GrowthDriver = {
  id: string;
  mustDoId: string;
  title: string;
  oneLine: string;
  hypotheses: string[];
  activities: QuarterActivity[];
  focusMarkets: string[];
  confidence: number;
  evidence: string[];
  whatWouldChangeOurMind: string;
  validateNext: string[];
  simulationPrompt: string;
};

type MustDo = {
  id: string;
  title: string;
  summary: string;
  apSplit: number;
  confidence: number;
  focusMarkets: string[];
};

const MUST_DOS: MustDo[] = [
  {
    id: 'gameday',
    title: 'Own NFL Gameday',
    summary:
      'Reinforce Crown Royal as the Whisky of the NFL across stadium, sports-bar, and home gameday occasions.',
    apSplit: 44,
    confidence: 73,
    focusMarkets: ['Dallas', 'Pittsburgh', 'Buffalo', 'Kansas City'],
  },
  {
    id: 'tailgating',
    title: 'Win Football Tailgating',
    summary:
      'Make Crown Royal Peach the default tailgate pour through signature serves and grill/sauce partnerships in NFL-heavy markets.',
    apSplit: 33,
    confidence: 68,
    focusMarkets: ['Green Bay', 'Nashville', 'Tampa', 'Atlanta'],
  },
  {
    id: 'hosting',
    title: 'Build Sunday Hosting Rituals',
    summary:
      'Stake the Sunday couch as a Crown Royal moment via recipe and serving content and Q4 retail display kits.',
    apSplit: 23,
    confidence: 61,
    focusMarkets: ['New York', 'Chicago', 'Philadelphia', 'Phoenix'],
  },
];

const GROWTH_DRIVERS: GrowthDriver[] = [
  {
    id: 'stadium-suite-ritual',
    mustDoId: 'gameday',
    title: 'Stadium suite ritual',
    oneLine:
      'Anchor Crown Royal as the premium pour inside NFL stadium suites and clubs, with hospitality cues fans actively notice.',
    hypotheses: [
      'Premium suite occasions still reward whisky on prestige cues, so Crown Royal earns presence where the moment warrants it.',
      'A recognizable suite ritual — signature serve plus branded glassware — carries from gameday into year-round venue use.',
    ],
    activities: [
      { quarter: 'Q3', label: 'Suite menu refresh', emphasis: 'launch' },
      { quarter: 'Q4', label: 'Premium hospitality launch', emphasis: 'sustain' },
      { quarter: 'Q1', label: 'Playoff luxury packages', emphasis: 'pulse' },
      { quarter: 'Q2', label: 'Draft-night clubroom', emphasis: 'sustain' },
    ],
    focusMarkets: ['Dallas', 'Pittsburgh', 'Buffalo', 'Kansas City'],
    confidence: 74,
    evidence: [
      'Demo placeholder: NFL suite occasions over-index on premium-spirit choice across the whisky category.',
      'Demo placeholder: branded glassware lifts brand recall when paired with a repeatable signature serve.',
    ],
    whatWouldChangeOurMind:
      'If suite operators cannot land the signature serve consistently, or if guests read the hospitality as background rather than a brand moment.',
    validateNext: [
      'Walk the proposed suite serve past three venue operators for execution risk.',
      'Check whether suite recall translates into household reach beyond ticket holders.',
    ],
    simulationPrompt:
      'Stress-test whether suite spend should stay in tier-1 NFL cities or extend into playoff host markets.',
  },
  {
    id: 'sports-bar-takeover',
    mustDoId: 'gameday',
    title: 'Sports-bar takeover',
    oneLine:
      'Become the default Sunday whisky pour at NFL-loud sports bars through staff training, gameday menus, and at-home watch-party kits.',
    hypotheses: [
      'Bartender recommendations move whisky choice in sports-bar settings, so staff training has outsized return on spend.',
      'A travel-ready watch-party kit lets the bar moment carry into home hosting without reshooting creative.',
    ],
    activities: [
      { quarter: 'Q3', label: 'Bar staff training', emphasis: 'launch' },
      { quarter: 'Q4', label: 'Gameday LTO menus', emphasis: 'sustain' },
      { quarter: 'Q1', label: 'Watch-party kits', emphasis: 'pulse' },
      { quarter: 'Q2', label: 'Off-season cocktail rotation', emphasis: 'sustain' },
    ],
    focusMarkets: ['Dallas', 'Pittsburgh', 'Buffalo', 'Kansas City'],
    confidence: 70,
    evidence: [
      'Demo placeholder: sports-bar staff recommendations swing trial more than menu position alone.',
      'Demo placeholder: shared watch-party kits travel from bar to home without losing the brand cue.',
    ],
    whatWouldChangeOurMind:
      'If staff training does not hold past kickoff weekend, or if LTO menus get displaced by competitor placements once the season is on.',
    validateNext: [
      'Audit how many trained bars still feature Crown Royal in week 8.',
      'Compare watch-party kit redemption against a simple coupon offer.',
    ],
    simulationPrompt:
      'Stress-test whether sports-bar staff training holds its lift past the first month of the season.',
  },
  {
    id: 'crown-peach-tailgate',
    mustDoId: 'tailgating',
    title: 'Crown Peach tailgate',
    oneLine:
      'Make Crown Royal Peach the default tailgate pour, anchored by signature-serve content and grill/sauce partnerships in NFL-heavy markets.',
    hypotheses: [
      'Tailgaters lean toward sweet-finish whiskies, so Crown Peach has a structural advantage over flagship Crown.',
      'Pairing with a grill/sauce partner gives the tailgate occasion a built-in co-promo footprint without inflating paid media.',
    ],
    activities: [
      { quarter: 'Q3', label: 'Tailgate kit launch', emphasis: 'launch' },
      { quarter: 'Q4', label: 'Grill-partner co-promo', emphasis: 'sustain' },
      { quarter: 'Q1', label: 'Playoff parking-lot push', emphasis: 'pulse' },
      { quarter: 'Q2', label: 'Recipe library refresh', emphasis: 'sustain' },
    ],
    focusMarkets: ['Green Bay', 'Nashville', 'Tampa', 'Atlanta'],
    confidence: 71,
    evidence: [
      'Demo placeholder: flavored whisky over-indexes in outdoor and tailgate occasions.',
      'Demo placeholder: co-branded grill content drives stronger serve recall than standalone ads.',
    ],
    whatWouldChangeOurMind:
      'If Crown Peach trial in tailgate occasions cannibalizes flagship Crown more than it recruits new buyers.',
    validateNext: [
      'Compare Crown Peach trial lift across markets with and without a grill partner.',
      'Validate which serve format — cocktail, shot, or mixer — carries the highest at-event repeat.',
    ],
    simulationPrompt:
      'Stress-test whether tailgate spend should weight to Crown Peach or stay split with flagship Crown.',
  },
  {
    id: 'grill-sauce-partnerships',
    mustDoId: 'tailgating',
    title: 'Grill & sauce partnerships',
    oneLine:
      'Lock Crown Royal into the gameday cookout through co-branded grill, sauce, and rub partnerships that meet shoppers in the aisle.',
    hypotheses: [
      'A grill or sauce partner already owns the cookout cart, so the partnership delivers shelf reach we would otherwise pay to build.',
      'Co-branded SKUs at peak season give retailers a real reason to feature Crown Royal in front-of-store displays.',
    ],
    activities: [
      { quarter: 'Q3', label: 'Partner shortlisting', emphasis: 'launch' },
      { quarter: 'Q4', label: 'Co-branded SKU drop', emphasis: 'sustain' },
      { quarter: 'Q1', label: 'Playoff bundles', emphasis: 'pulse' },
      { quarter: 'Q2', label: 'Learnings into next season', emphasis: 'sustain' },
    ],
    focusMarkets: ['Green Bay', 'Nashville', 'Tampa', 'Atlanta'],
    confidence: 66,
    evidence: [
      'Demo placeholder: co-branded BBQ partnerships unlock end-cap features outside the spirits aisle.',
      'Demo placeholder: playoff bundles travel well when paired with grocery sauce SKUs.',
    ],
    whatWouldChangeOurMind:
      'If chosen partners trade short-term volume for a brand fit Crown Royal cannot live with year-round.',
    validateNext: [
      'Pressure-test the partner shortlist with retail account leads.',
      'Measure whether co-branded SKUs hold price versus pure discount features.',
    ],
    simulationPrompt:
      'Stress-test whether co-branded grill partners should anchor mass retail or premium grocery first.',
  },
  {
    id: 'sunday-funday-recipes',
    mustDoId: 'hosting',
    title: 'Sunday Funday recipes',
    oneLine:
      'Stake the Sunday couch as a Crown Royal moment with recipe content, hosting cues, and serve ideas that travel from social to the kitchen.',
    hypotheses: [
      'Sunday hosts borrow recipes more than they borrow ads, so recipe-led content is the durable hook for the occasion.',
      'Holiday and football overlap in Q4 compresses hosting demand into the same weeks we already plan against.',
    ],
    activities: [
      { quarter: 'Q3', label: 'Recipe content drop', emphasis: 'launch' },
      { quarter: 'Q4', label: 'Holiday + football overlap', emphasis: 'sustain' },
      { quarter: 'Q1', label: 'Playoff hosting kits', emphasis: 'pulse' },
      { quarter: 'Q2', label: 'Carry-over to NCAA', emphasis: 'sustain' },
    ],
    focusMarkets: ['New York', 'Chicago', 'Philadelphia', 'Phoenix'],
    confidence: 67,
    evidence: [
      'Demo placeholder: recipe-led content compounds reach better than one-off creative bursts.',
      'Demo placeholder: NFL and holiday hosting overlap concentrates a meaningful share of seasonal volume.',
    ],
    whatWouldChangeOurMind:
      'If hosts treat the recipes as content to scroll past rather than save and serve at the next Sunday gathering.',
    validateNext: [
      'Track save and share rates on Sunday Funday recipe posts versus standard creative.',
      'Pilot a small NCAA-season carry-over to see if the ritual holds outside the NFL window.',
    ],
    simulationPrompt:
      'Stress-test whether Sunday hosting spend should follow the NFL calendar or extend through bowl season.',
  },
  {
    id: 'q4-retail-display-kits',
    mustDoId: 'hosting',
    title: 'Q4 retail display kits',
    oneLine:
      'Lock in big-box and grocery Q4 display kits that turn Crown Royal into the visible Sunday hosting cue at point of purchase.',
    hypotheses: [
      'Q4 display real estate gets crowded fast, so design and approval need to land before the season starts to win shelf.',
      'Reusing display assets into a playoff reset lets the same investment work twice without new creative cost.',
    ],
    activities: [
      { quarter: 'Q3', label: 'Display design lock', emphasis: 'launch' },
      { quarter: 'Q4', label: 'Big-box rollout', emphasis: 'sustain' },
      { quarter: 'Q1', label: 'Reset for playoffs', emphasis: 'pulse' },
      { quarter: 'Q2', label: 'Learnings for next year', emphasis: 'sustain' },
    ],
    focusMarkets: ['New York', 'Chicago', 'Philadelphia', 'Phoenix'],
    confidence: 64,
    evidence: [
      'Demo placeholder: locked Q4 display design wins more end caps than late-cycle requests.',
      'Demo placeholder: playoff resets extend display ROI when assets are designed to be reused.',
    ],
    whatWouldChangeOurMind:
      'If retail buyers cannot commit to enough Q4 end-cap placements to justify the display investment.',
    validateNext: [
      'Confirm end-cap commitments by retailer before locking the print run.',
      'Test a small playoff-reset pilot in two markets before scaling.',
    ],
    simulationPrompt:
      'Stress-test whether Q4 display spend should focus on big-box, grocery, or club channels first.',
  },
];

const QUARTERS: Quarter[] = ['Q3', 'Q4', 'Q1', 'Q2'];

const QUARTER_LABELS: Record<Quarter, string> = {
  Q3: 'Q3 2026',
  Q4: 'Q4 2026',
  Q1: 'Q1 2027',
  Q2: 'Q2 2027',
};

const QUARTER_STYLES: Record<
  QuarterActivity['emphasis'],
  { badge: string; bar: string }
> = {
  launch: {
    badge: 'border-blue-200 bg-blue-50 text-blue-700',
    bar: 'border-blue-200 bg-blue-50 text-blue-800',
  },
  sustain: {
    badge: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    bar: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  },
  pulse: {
    badge: 'border-amber-200 bg-amber-50 text-amber-700',
    bar: 'border-amber-200 bg-amber-50 text-amber-800',
  },
};

export default function GrowthDriverPage() {
  const data = useStudyData();
  const [selectedId, setSelectedId] = useState('crown-peach-tailgate');
  const selected =
    GROWTH_DRIVERS.find((driver) => driver.id === selectedId) ??
    GROWTH_DRIVERS[0];

  const selectedMustDo = useMemo(
    () => MUST_DOS.find((mustDo) => mustDo.id === selected.mustDoId),
    [selected.mustDoId],
  );

  const handleStressTest = (driverId: string) => {
    setSelectedId(driverId);
  };

  return (
    <StudyShell
      data={data}
      eyebrow="Growth driver planner"
      title="Plan growth drivers, with the evidence and confidence beside each card"
      intro="Demo planner inspired by a Crown Royal NFL-season MBP. Each Must-Do and Growth Driver carries a confidence pill, an evidence chip, and a stress-test action so the plan stays honest before any spend moves."
      contentClassName="max-w-[1420px]"
    >
      <FocusCard className="overflow-hidden p-0 sm:p-0">
        <section className="border-b border-slate-200 bg-white px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-amber-200 bg-amber-50 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-700"
                >
                  Demo / illustrative
                </Badge>
                <span className="text-[12px] text-slate-500">
                  Must-Dos → Growth Drivers → Activities → A&amp;P split → markets → confidence
                </span>
              </div>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                Crown Royal’s growth driver planner
              </h2>
              <p className="mt-1 max-w-3xl text-sm leading-snug text-slate-600">
                Start from familiar MBP choices, then open each driver to see the
                belief behind it, the evidence we have, and the next validation step.
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-right">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                A&amp;P total
              </div>
              <div className="text-lg font-semibold text-slate-950">100%</div>
              <div className="text-[11px] text-slate-500">demo split</div>
            </div>
          </div>
        </section>

        <section className="grid gap-0 xl:grid-cols-[280px_minmax(0,1fr)_360px]">
          <aside className="border-b border-slate-200 bg-slate-50/70 p-4 xl:border-b-0 xl:border-r">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <Target className="h-3.5 w-3.5" />
              Must-Dos
            </div>
            <div className="mt-3 grid gap-3">
              {MUST_DOS.map((mustDo) => {
                const active = mustDo.id === selected.mustDoId;
                const firstDriver = GROWTH_DRIVERS.find(
                  (driver) => driver.mustDoId === mustDo.id,
                );
                return (
                  <div
                    key={mustDo.id}
                    className={cn(
                      'rounded-2xl border bg-white p-3 shadow-sm transition-colors',
                      active
                        ? 'border-slate-900 ring-2 ring-slate-900/10'
                        : 'border-slate-200 hover:border-slate-300',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (firstDriver) setSelectedId(firstDriver.id);
                      }}
                      className="grid w-full gap-2 text-left"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-semibold leading-snug text-slate-950">
                          {mustDo.title}
                        </h3>
                        <span
                          className="rounded-full bg-slate-950 px-2 py-0.5 text-[11px] font-semibold text-white"
                          title="Share of growth-driver A&P this Must-Do receives"
                        >
                          {mustDo.apSplit}%
                        </span>
                      </div>
                      <p className="text-[12px] leading-snug text-slate-600">
                        {mustDo.summary}
                      </p>
                      <ConfidencePill value={mustDo.confidence} />
                    </button>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {mustDo.focusMarkets.slice(0, 3).map((market) => (
                        <span
                          key={market}
                          className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-600"
                        >
                          {market}
                        </span>
                      ))}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                        <FileSearch className="h-3 w-3 text-slate-500" />
                        Evidence: portfolio MBP brief
                      </span>
                      {firstDriver ? (
                        <button
                          type="button"
                          onClick={() => handleStressTest(firstDriver.id)}
                          className="inline-flex h-7 items-center gap-1.5 rounded-full bg-slate-950 px-2.5 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
                          title={`Open ${firstDriver.title} on the right to stress-test the Must-Do.`}
                        >
                          <Play className="h-3 w-3" />
                          Stress-test
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>

          <main className="min-w-0 border-b border-slate-200 p-4 xl:border-b-0 xl:border-r">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <CalendarDays className="h-3.5 w-3.5" />
                  Quarterly activation board
                </div>
                <p className="mt-1 text-[12px] text-slate-500">
                  Select a growth driver to open its plan on the right.
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                {Object.entries(QUARTER_STYLES).map(([key, style]) => (
                  <span
                    key={key}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize',
                      style.badge,
                    )}
                  >
                    {key}
                  </span>
                ))}
              </div>
            </div>

            <div className="mt-4 overflow-x-auto">
              <div className="min-w-[760px]">
                <div className="grid grid-cols-[210px_repeat(4,minmax(120px,1fr))] gap-2 border-b border-slate-100 pb-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                    Growth driver
                  </div>
                  {QUARTERS.map((quarter) => (
                    <div
                      key={quarter}
                      className="rounded-xl bg-slate-100 px-3 py-2 text-center text-xs font-semibold text-slate-600"
                    >
                      {QUARTER_LABELS[quarter]}
                    </div>
                  ))}
                </div>

                <div className="mt-2 grid gap-2">
                  {GROWTH_DRIVERS.map((driver) => (
                    <DriverRow
                      key={driver.id}
                      driver={driver}
                      active={driver.id === selected.id}
                      mustDo={MUST_DOS.find((mustDo) => mustDo.id === driver.mustDoId)}
                      onSelect={() => setSelectedId(driver.id)}
                      onStressTest={() => handleStressTest(driver.id)}
                    />
                  ))}
                </div>
              </div>
            </div>
          </main>

          <DriverDetail
            driver={selected}
            mustDo={selectedMustDo}
            studyId={data.studyId}
          />
        </section>
      </FocusCard>
    </StudyShell>
  );
}

function DriverRow({
  driver,
  mustDo,
  active,
  onSelect,
  onStressTest,
}: {
  driver: GrowthDriver;
  mustDo?: MustDo;
  active: boolean;
  onSelect: () => void;
  onStressTest: () => void;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[210px_repeat(4,minmax(120px,1fr))] gap-2 rounded-2xl border p-2 text-left transition-colors',
        active
          ? 'border-slate-900 bg-slate-950/[0.02] shadow-sm'
          : 'border-transparent bg-white hover:border-slate-200 hover:bg-slate-50',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="grid gap-1.5 rounded-xl bg-white px-3 py-2 text-left shadow-sm ring-1 ring-slate-200"
      >
        <div className="text-sm font-semibold leading-snug text-slate-950">
          {driver.title}
        </div>
        <div className="text-[11px] leading-snug text-slate-500">
          {mustDo?.title ?? 'Must-Do'}
        </div>
        <ConfidencePill value={driver.confidence} />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-600">
            <FileSearch className="h-3 w-3 text-slate-500" />
            Evidence
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onStressTest();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                onStressTest();
              }
            }}
            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-full bg-slate-950 px-2 text-[10px] font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
          >
            <Play className="h-3 w-3" />
            Stress-test
          </span>
        </div>
      </button>
      {QUARTERS.map((quarter) => {
        const activity = driver.activities.find((item) => item.quarter === quarter);
        if (!activity) {
          return (
            <div
              key={quarter}
              className="rounded-xl border border-dashed border-slate-200 bg-slate-50"
            />
          );
        }
        return (
          <div
            key={quarter}
            className={cn(
              'flex min-h-24 items-center rounded-xl border px-3 py-2 text-[12px] font-semibold leading-snug shadow-sm',
              QUARTER_STYLES[activity.emphasis].bar,
            )}
          >
            {activity.label}
          </div>
        );
      })}
    </div>
  );
}

function DriverDetail({
  driver,
  mustDo,
  studyId,
}: {
  driver: GrowthDriver;
  mustDo?: MustDo;
  studyId: string | null;
}) {
  return (
    <aside className="bg-white p-4">
      <div className="sticky top-16 grid gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="border-slate-300 bg-white text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500"
            >
              Selected driver
            </Badge>
            {mustDo ? (
              <span className="text-[11px] font-medium text-slate-500">
                {mustDo.title}
              </span>
            ) : null}
          </div>
          <h3 className="mt-2 text-lg font-semibold tracking-tight text-slate-950">
            {driver.title}
          </h3>
          <p className="mt-1 text-sm leading-snug text-slate-600">{driver.oneLine}</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Confidence
            </span>
            <span className="text-sm font-semibold text-slate-950">
              {driver.confidence}%
            </span>
          </div>
          <ConfidenceMeter value={driver.confidence} className="mt-2" />
          <div className="mt-3 flex flex-wrap gap-1">
            {driver.focusMarkets.map((market) => (
              <span
                key={market}
                className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600"
              >
                {market}
              </span>
            ))}
          </div>
        </div>

        <DetailBlock title="Hypotheses" icon={<Sparkles className="h-3.5 w-3.5" />}>
          <ul className="grid gap-2">
            {driver.hypotheses.map((item) => (
              <li key={item} className="flex gap-2 text-sm leading-snug text-slate-700">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                {item}
              </li>
            ))}
          </ul>
        </DetailBlock>

        <DetailBlock title="Evidence placeholders" icon={<HelpCircle className="h-3.5 w-3.5" />}>
          <ul className="grid gap-2">
            {driver.evidence.map((item) => (
              <li key={item} className="text-sm leading-snug text-slate-700">
                {item}
              </li>
            ))}
          </ul>
        </DetailBlock>

        <DetailBlock title="What would change our mind">
          <p className="text-sm leading-snug text-slate-700">
            {driver.whatWouldChangeOurMind}
          </p>
        </DetailBlock>

        <DetailBlock title="What to validate next">
          <ul className="grid gap-2">
            {driver.validateNext.map((item) => (
              <li key={item} className="text-sm leading-snug text-slate-700">
                {item}
              </li>
            ))}
          </ul>
        </DetailBlock>

        <div className="rounded-2xl border border-slate-900 bg-slate-950 p-3 text-white shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
            Stress-test this driver
          </div>
          <p className="mt-1 text-sm leading-snug text-slate-200">
            {driver.simulationPrompt}
          </p>
          <div className="mt-3 grid gap-2">
            <ActionLink
              href={withStudy('/simulation', studyId, {
                driver: driver.id,
                must_do: driver.mustDoId,
              })}
              icon={<Play className="h-3.5 w-3.5" />}
            >
              Stress-test growth driver
            </ActionLink>
            <ActionLink
              href={withStudy('/robustness', studyId, {
                recommendation: driver.id,
              })}
              icon={<Compass className="h-3.5 w-3.5" />}
            >
              See robustness
            </ActionLink>
            <ActionLink
              href={withStudy('/ask', studyId, { driver: driver.id })}
              icon={<MessageCircle className="h-3.5 w-3.5" />}
            >
              Ask
            </ActionLink>
            <ActionLink
              href={withStudy('/evidence', studyId, {
                driver: driver.id,
                source: 'growth-driver-demo',
              })}
              icon={<HelpCircle className="h-3.5 w-3.5" />}
            >
              Open evidence
            </ActionLink>
          </div>
        </div>
      </div>
    </aside>
  );
}

function ConfidenceMeter({
  value,
  className,
  compact,
}: {
  value: number;
  className?: string;
  compact?: boolean;
}) {
  const tone =
    value >= 70
      ? 'bg-emerald-500'
      : value >= 60
        ? 'bg-amber-500'
        : 'bg-orange-500';

  return (
    <div className={cn('grid gap-1', className)}>
      <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-slate-500">
        <span>{compact ? 'Confidence' : 'Confidence'}</span>
        <span>{phraseConfidence(value)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function ConfidencePill({ value }: { value: number }) {
  const tone =
    value >= 70
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : value >= 60
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-orange-200 bg-orange-50 text-orange-700';
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold',
        tone,
      )}
      title="Internal confidence based on signal strength and number of supporting framings"
    >
      Confidence: {phraseConfidence(value)}
    </span>
  );
}

function phraseConfidence(value: number): string {
  const word =
    value >= 75
      ? 'High'
      : value >= 60
        ? 'Medium'
        : value >= 40
          ? 'Low'
          : 'Limited';
  return `${word} (${value}%)`;
}

function DetailBlock({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <h4 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {icon}
        {title}
      </h4>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function ActionLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-9 items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-white/15"
    >
      <span className="inline-flex items-center gap-2">
        {icon}
        {children}
      </span>
      <ArrowRight className="h-3.5 w-3.5 text-slate-300" />
    </Link>
  );
}

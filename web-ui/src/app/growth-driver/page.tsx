'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
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
    id: 'distinctiveness',
    title: 'Regain distinctiveness',
    summary:
      'Unite World Cup Hispanic fans through music, reenergize on-premise, and celebrate the taste of Hispanic culture.',
    apSplit: 42,
    confidence: 72,
    focusMarkets: ['Miami', 'Los Angeles', 'Houston', 'New York'],
  },
  {
    id: 'pina',
    title: 'Unleash Piña',
    summary:
      'Seize daytime occasions and maximize summer holidays with an easy, refreshing Piña story.',
    apSplit: 34,
    confidence: 65,
    focusMarkets: ['Florida', 'Texas', 'California', 'Arizona'],
  },
  {
    id: 'value',
    title: 'Deliver more value',
    summary:
      'Optimize the format mix and activate formats that help shoppers choose Buchanan’s more often.',
    apSplit: 24,
    confidence: 61,
    focusMarkets: ['National retail', 'Club', 'Grocery', 'Convenience'],
  },
];

const GROWTH_DRIVERS: GrowthDriver[] = [
  {
    id: 'world-cup-music',
    mustDoId: 'distinctiveness',
    title: 'World Cup music moments',
    oneLine:
      'Make Buchanan’s the whisky brand that shows up where Hispanic fans gather before and after matches.',
    hypotheses: [
      'Music-led watch parties can make the brand feel culturally present, not just advertised.',
      'A clear on-premise ritual gives bartenders and hosts a reason to recommend Buchanan’s.',
    ],
    activities: [
      { quarter: 'Q1', label: 'Artist and venue partners', emphasis: 'launch' },
      { quarter: 'Q2', label: 'Matchday music series', emphasis: 'pulse' },
      { quarter: 'Q3', label: 'On-premise ritual push', emphasis: 'sustain' },
      { quarter: 'Q4', label: 'Finals and holiday hosting', emphasis: 'pulse' },
    ],
    focusMarkets: ['Miami', 'Los Angeles', 'Houston', 'New York'],
    confidence: 74,
    evidence: [
      'Demo placeholder: Hispanic soccer viewing occasions over-index on group hosting.',
      'Demo placeholder: music partnerships lift recall when tied to a repeated ritual.',
    ],
    whatWouldChangeOurMind:
      'If venue partners cannot deliver repeat attendance, or if fans read the activation as generic sponsorship.',
    validateNext: [
      'Pressure-test partner shortlist with local sales leads.',
      'Compare music-led and food-led creative in a quick concept read.',
    ],
    simulationPrompt:
      'Stress-test whether World Cup music spend should stay national or move into the four focus markets.',
  },
  {
    id: 'hispanic-taste',
    mustDoId: 'distinctiveness',
    title: 'Taste of Hispanic culture',
    oneLine:
      'Give Buchanan’s a food and flavor role that feels specific to Hispanic celebrations.',
    hypotheses: [
      'Cultural taste cues can refresh distinctiveness without changing the core liquid story.',
      'Retail and on-premise can use the same flavor cues if the serve is simple.',
    ],
    activities: [
      { quarter: 'Q1', label: 'Serve and food pairings', emphasis: 'launch' },
      { quarter: 'Q2', label: 'Cinco and summer hosting', emphasis: 'pulse' },
      { quarter: 'Q3', label: 'Retail display kits', emphasis: 'sustain' },
      { quarter: 'Q4', label: 'Holiday table content', emphasis: 'pulse' },
    ],
    focusMarkets: ['Los Angeles', 'Houston', 'Chicago'],
    confidence: 69,
    evidence: [
      'Demo placeholder: food-led Hispanic culture work improves relevance among light buyers.',
      'Demo placeholder: simple serves travel better from social to store displays.',
    ],
    whatWouldChangeOurMind:
      'If taste cues dilute premium perception or repeat buyers do not recognize Buchanan’s in the work.',
    validateNext: [
      'Run a creative check on premium cues.',
      'Ask distributors which serve materials would actually be used.',
    ],
    simulationPrompt:
      'Compare a food-led route against the matchday music route for distinctiveness and purchase intent.',
  },
  {
    id: 'daytime-pina',
    mustDoId: 'pina',
    title: 'Daytime Piña occasions',
    oneLine:
      'Position Buchanan’s Piña as an easy daytime choice for brunch, patio, and beach-adjacent occasions.',
    hypotheses: [
      'Daytime occasions can bring in incremental serves without competing directly with the core evening ritual.',
      'Light, bright creative can make whisky feel easier to consider in warm-weather moments.',
    ],
    activities: [
      { quarter: 'Q1', label: 'Brunch and patio playbook', emphasis: 'launch' },
      { quarter: 'Q2', label: 'Memorial Day launch', emphasis: 'pulse' },
      { quarter: 'Q3', label: 'Summer holiday bursts', emphasis: 'pulse' },
      { quarter: 'Q4', label: 'Learnings for next summer', emphasis: 'sustain' },
    ],
    focusMarkets: ['Florida', 'Texas', 'California', 'Arizona'],
    confidence: 67,
    evidence: [
      'Demo placeholder: warm-weather occasions show headroom for flavored whisky.',
      'Demo placeholder: holiday bursts are easier to fund when linked to clear serve ideas.',
    ],
    whatWouldChangeOurMind:
      'If daytime Piña mainly shifts existing buyers from evening occasions instead of recruiting new ones.',
    validateNext: [
      'Estimate incremental reach by occasion.',
      'Test whether holiday creative improves trial intent among lighter whisky buyers.',
    ],
    simulationPrompt:
      'Simulate moving 5 points of spend from Q4 hosting into Q2 and Q3 Piña holiday bursts.',
  },
  {
    id: 'format-mix',
    mustDoId: 'value',
    title: 'Format mix activation',
    oneLine:
      'Use the right pack and size message for each channel so value feels helpful, not cheap.',
    hypotheses: [
      'Format guidance can protect premium perception while still answering price sensitivity.',
      'Channel-specific packs can reduce wasted spend on broad discounting.',
    ],
    activities: [
      { quarter: 'Q1', label: 'Channel format rules', emphasis: 'launch' },
      { quarter: 'Q2', label: 'Club and grocery tests', emphasis: 'sustain' },
      { quarter: 'Q3', label: 'Back-to-gathering offers', emphasis: 'pulse' },
      { quarter: 'Q4', label: 'Holiday value bundles', emphasis: 'pulse' },
    ],
    focusMarkets: ['National retail', 'Club', 'Grocery', 'Convenience'],
    confidence: 62,
    evidence: [
      'Demo placeholder: value sensitivity rises when shoppers trade across bottle sizes.',
      'Demo placeholder: bundle messaging performs better when anchored in hosting needs.',
    ],
    whatWouldChangeOurMind:
      'If larger formats cannibalize premium bottles faster than they recruit new shoppers.',
    validateNext: [
      'Check format elasticity by channel.',
      'Ask sales teams where bundle execution is realistic this year.',
    ],
    simulationPrompt:
      'Model whether value spend should favor larger formats, smaller trial packs, or holiday bundles.',
  },
];

const QUARTERS: Quarter[] = ['Q1', 'Q2', 'Q3', 'Q4'];

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
  const [selectedId, setSelectedId] = useState(GROWTH_DRIVERS[0].id);
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
      intro="Demo planner inspired by Buchanan’s MBP slide. Each Must-Do and Growth Driver carries a confidence pill, an evidence chip, and a stress-test action so the plan stays honest before any spend moves."
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
                Buchanan’s growth driver planner
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
                      {quarter}
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
  const linkParams = { driver: driver.id };

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
                ...linkParams,
                prompt: 'stress-test-growth-driver',
              })}
              icon={<Play className="h-3.5 w-3.5" />}
            >
              Stress-test growth driver
            </ActionLink>
            <ActionLink
              href={withStudy('/simulation', studyId, {
                ...linkParams,
                prompt: 'simulate-ap-shift',
              })}
              icon={<ArrowRight className="h-3.5 w-3.5" />}
            >
              Simulate A&amp;P shift
            </ActionLink>
            <ActionLink
              href={withStudy('/ask', studyId, {
                ...linkParams,
                question: `What should we believe about ${driver.title}?`,
              })}
              icon={<MessageCircle className="h-3.5 w-3.5" />}
            >
              Ask about this driver
            </ActionLink>
            <ActionLink
              href={withStudy('/evidence', studyId, {
                ...linkParams,
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

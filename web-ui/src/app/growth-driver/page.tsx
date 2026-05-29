'use client';

/**
 * Growth-driver planner — 3-column reading flow.
 *
 * The page deliberately has no narrative header. It starts directly with
 * the MBP working surface and reads left to right:
 *
 *   Column A — Strategy: "What are we doing this year?"
 *   Column B — Bets:     "How are we placing them?"
 *   Column C — Argument: "Should we believe it, and what would change our mind?"
 *
 * Each Must-Do (Column A) groups one or more Growth Drivers (Column B).
 * Selecting a Must-Do opens its first driver; selecting a driver opens
 * the argument & action surface (Column C).
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { classifyPointerTier } from '@/components/evidence/source-tier';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  wb,
  type GrowthDriverDTO,
  type GrowthDriversResponse,
  type MustDoDTO,
} from '@/components/workbench/types';

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
  fragileAssumption: string;
  illustrative: boolean;
  assetKeyEncoded: string | null;
};

type MustDo = {
  id: string;
  title: string;
  summary: string;
  apSplit: number;
  confidence: number;
  focusMarkets: string[];
};

// Single seeded MBP for the demo. Brand / label / cycle live here
// rather than on the page so the chrome stays a single line of strings.
const SEEDED_MBP = {
  brand: 'Crown Royal',
  mbpLabel: 'Crown Royal × NFL 2026-27 MBP',
  cycleWindow: 'Q3 2026 → Q2 2027',
};

// The typed stress-test set. Each entry becomes one labeled button in
// Column C and one URL contract for /simulation:
//   /simulation?study=<id>&driver=<id>&must_do=<id>&prompt=<prompt>
const STRESS_TESTS: Array<{ prompt: string; label: string }> = [
  {
    prompt: 'flip-fragile-assumption',
    label: 'If our fragile assumption is wrong, does the driver still hold?',
  },
  {
    prompt: 'cut-ap-30',
    label: 'Does this driver still hold with a 30% A&P cut?',
  },
  {
    prompt: 'add-competitor-response',
    label:
      'If competitors step up in the focus markets, does our advantage compress?',
  },
  {
    prompt: 'alternative-driver',
    label: 'What if we put this A&P behind a peer driver instead?',
  },
  {
    prompt: 'in-year-since-last-quarter',
    label: 'What changed in-year since the last quarter?',
  },
];

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
      'NFL suite occasions over-index on premium-spirit choice across the whisky category.',
      'Branded glassware lifts brand recall when paired with a repeatable signature serve.',
    ],
    fragileAssumption:
      'Suite operators consistently land the signature serve and guests read the hospitality as a branded moment, not background.',
    illustrative: true,
    assetKeyEncoded: null,
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
      'Sports-bar staff recommendations swing trial more than menu position alone.',
      'Shared watch-party kits travel from bar to home without losing the brand cue.',
    ],
    fragileAssumption:
      'Staff training holds past kickoff weekend, and LTO menus are not displaced by competitor placements once the season is on.',
    illustrative: true,
    assetKeyEncoded: null,
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
      'Flavored whisky over-indexes in outdoor and tailgate occasions.',
      'Co-branded grill content drives stronger serve recall than standalone ads.',
    ],
    fragileAssumption:
      'If competitor tailgate spend in TX/WI rises 20% or more year on year, Crown Peach’s structural tailgate advantage compresses 8–14 points.',
    illustrative: false,
    assetKeyEncoded: null,
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
      'Co-branded BBQ partnerships unlock end-cap features outside the spirits aisle.',
      'Playoff bundles travel well when paired with grocery sauce SKUs.',
    ],
    fragileAssumption:
      'Chosen partners deliver short-term volume without forcing Crown Royal into a brand fit it cannot live with year-round.',
    illustrative: true,
    assetKeyEncoded: null,
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
      'Recipe-led content compounds reach better than one-off creative bursts.',
      'NFL and holiday hosting overlap concentrates a meaningful share of seasonal volume.',
    ],
    fragileAssumption:
      'Hosts save and serve the recipes at the next Sunday gathering rather than scrolling past them.',
    illustrative: true,
    assetKeyEncoded: null,
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
      'Locked Q4 display design wins more end caps than late-cycle requests.',
      'Playoff resets extend display ROI when assets are designed to be reused.',
    ],
    fragileAssumption:
      'Retail buyers commit to enough Q4 end-cap placements to justify the display investment.',
    illustrative: true,
    assetKeyEncoded: null,
  },
];

const QUARTERS: Quarter[] = ['Q3', 'Q4', 'Q1', 'Q2'];

const QUARTER_LABELS: Record<Quarter, string> = {
  Q3: 'Q3 26',
  Q4: 'Q4 26',
  Q1: 'Q1 27',
  Q2: 'Q2 27',
};

const QUARTER_STYLES: Record<
  QuarterActivity['emphasis'],
  { bar: string }
> = {
  launch: { bar: 'border-blue-200 bg-blue-50 text-blue-800' },
  sustain: { bar: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
  pulse: { bar: 'border-amber-200 bg-amber-50 text-amber-800' },
};

type LoadState = 'pending' | 'live' | 'fallback';

type DriverFetch = {
  studyId: string;
  mustDos: MustDo[] | null;
  drivers: GrowthDriver[] | null;
};

export default function GrowthDriverPage() {
  return (
    <Suspense fallback={null}>
      <GrowthDriverBody />
    </Suspense>
  );
}

function GrowthDriverBody() {
  const data = useStudyData();
  const { studyId } = data;

  // Try the live backend; fall back to the fixture (with a visible
  // chip) when the endpoint errors or returns zero drivers.
  const [fetched, setFetched] = useState<DriverFetch | null>(null);
  const [requestedId, setRequestedId] = useState('crown-peach-tailgate');

  useEffect(() => {
    if (!studyId) return;
    let cancelled = false;
    wb.growthDrivers(studyId)
      .then((res) => {
        if (cancelled) return;
        const hydrated = hydrateFromBackend(res);
        if (hydrated.drivers.length === 0) {
          setFetched({ studyId, mustDos: null, drivers: null });
          return;
        }
        setFetched({
          studyId,
          mustDos: hydrated.mustDos,
          drivers: hydrated.drivers,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setFetched({ studyId, mustDos: null, drivers: null });
      });
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  const isFetchedForStudy = Boolean(studyId) && fetched?.studyId === studyId;
  const hasLiveData =
    isFetchedForStudy &&
    fetched?.drivers != null &&
    fetched?.drivers.length > 0;

  const mustDos: MustDo[] = hasLiveData ? fetched!.mustDos! : MUST_DOS;
  const drivers: GrowthDriver[] = hasLiveData ? fetched!.drivers! : GROWTH_DRIVERS;

  const loadState: LoadState = !studyId
    ? 'fallback'
    : !isFetchedForStudy
      ? 'pending'
      : hasLiveData
        ? 'live'
        : 'fallback';

  const selected =
    drivers.find((d) => d.id === requestedId) ??
    drivers.find((d) => d.id === 'crown-peach-tailgate') ??
    drivers[0];

  const selectedMustDo = useMemo(
    () => mustDos.find((m) => m.id === selected?.mustDoId),
    [mustDos, selected?.mustDoId],
  );

  const driversForSelectedMustDo = useMemo(
    () => drivers.filter((d) => d.mustDoId === selected?.mustDoId),
    [drivers, selected?.mustDoId],
  );

  const totalApSplit = mustDos.reduce((sum, m) => sum + m.apSplit, 0);

  if (!studyId && data.studiesError) {
    return (
      <main className="px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-[1500px] rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-700">
          Workbench API unreachable · {data.studiesError}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-svh bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.10),transparent_32rem),linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)] px-4 py-6 font-sans text-slate-950 sm:px-6">
      <div className="mx-auto grid w-full max-w-[1500px] gap-3">
        {loadState === 'fallback' && studyId ? (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-800">
            <Badge
              variant="outline"
              className="border-amber-300 bg-white text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-800"
            >
              Illustrative
            </Badge>
            <span>
              Showing illustrative fixture; live growth-driver data not available.
            </span>
          </div>
        ) : null}

        <section className="grid grid-cols-1 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm xl:grid-cols-[280px_340px_minmax(0,1fr)]">
          <StrategyColumn
            mustDos={mustDos}
            drivers={drivers}
            selectedMustDoId={selected?.mustDoId ?? null}
            totalApSplit={totalApSplit}
            onSelectMustDo={(mustDoId) => {
              const first = drivers.find((d) => d.mustDoId === mustDoId);
              if (first) setRequestedId(first.id);
            }}
          />
          <BetsColumn
            mustDo={selectedMustDo}
            drivers={driversForSelectedMustDo}
            selectedDriverId={selected?.id ?? null}
            onSelectDriver={(id) => setRequestedId(id)}
          />
          {selected ? (
            <ArgumentColumn
              driver={selected}
              mustDo={selectedMustDo}
              studyId={studyId}
            />
          ) : (
            <div className="p-4 text-sm text-slate-600">
              No growth drivers loaded for this planning context yet.
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function StrategyColumn({
  mustDos,
  drivers,
  selectedMustDoId,
  totalApSplit,
  onSelectMustDo,
}: {
  mustDos: MustDo[];
  drivers: GrowthDriver[];
  selectedMustDoId: string | null;
  totalApSplit: number;
  onSelectMustDo: (mustDoId: string) => void;
}) {
  return (
    <aside className="border-b border-slate-200 bg-slate-50/70 p-4 xl:border-b-0 xl:border-r">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold leading-snug tracking-tight text-slate-950">
            {SEEDED_MBP.mbpLabel}
          </h1>
          <div className="text-[11px] text-slate-500">{SEEDED_MBP.cycleWindow}</div>
        </div>
        <span
          className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold tabular-nums text-slate-800"
          title="Share of growth-driver A&P across the Must-Dos"
        >
          A&amp;P total {totalApSplit}%
        </span>
      </div>
      <p className="mt-3 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
        What are we doing this year?
      </p>
      <div className="mt-2 grid gap-2">
        {mustDos.map((mustDo) => {
          const active = mustDo.id === selectedMustDoId;
          const driverCount = drivers.filter(
            (d) => d.mustDoId === mustDo.id,
          ).length;
          return (
            <button
              key={mustDo.id}
              type="button"
              onClick={() => onSelectMustDo(mustDo.id)}
              className={cn(
                'grid gap-1.5 rounded-2xl border bg-white p-3 text-left shadow-sm transition-colors',
                active
                  ? 'border-slate-900 ring-2 ring-slate-900/10'
                  : 'border-slate-200 hover:border-slate-300',
              )}
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
              <p className="line-clamp-2 text-[12px] leading-snug text-slate-600">
                {mustDo.summary}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <ConfidencePill value={mustDo.confidence} />
                <span className="text-[10px] text-slate-500 tabular-nums">
                  {driverCount} driver{driverCount === 1 ? '' : 's'}
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {mustDo.focusMarkets.slice(0, 4).map((market) => (
                  <span
                    key={market}
                    className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-600"
                  >
                    {market}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function BetsColumn({
  mustDo,
  drivers,
  selectedDriverId,
  onSelectDriver,
}: {
  mustDo: MustDo | undefined;
  drivers: GrowthDriver[];
  selectedDriverId: string | null;
  onSelectDriver: (driverId: string) => void;
}) {
  return (
    <aside className="border-b border-slate-200 bg-white p-4 xl:border-b-0 xl:border-r">
      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
        Bets inside {mustDo?.title ?? 'this Must-Do'}
      </p>
      <p className="mt-0.5 text-[12px] text-slate-600">How are we placing them?</p>
      <div className="mt-3 grid gap-2">
        {drivers.map((driver) => {
          const active = driver.id === selectedDriverId;
          return (
            <button
              key={driver.id}
              type="button"
              onClick={() => onSelectDriver(driver.id)}
              className={cn(
                'grid gap-1.5 rounded-2xl border bg-white p-3 text-left shadow-sm transition-colors',
                active
                  ? 'border-slate-900 ring-2 ring-slate-900/10'
                  : 'border-slate-200 hover:border-slate-300',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold leading-snug text-slate-950">
                  {driver.title}
                </h3>
                {driver.illustrative ? (
                  <Badge
                    variant="outline"
                    className="border-amber-300 bg-amber-50 text-[9px] font-semibold uppercase tracking-[0.16em] text-amber-800"
                  >
                    Illustrative
                  </Badge>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <ConfidencePill value={driver.confidence} />
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-600 tabular-nums">
                  {driver.evidence.length} evidence
                </span>
              </div>
              {driver.fragileAssumption ? (
                <p className="line-clamp-2 text-[12px] leading-snug text-slate-600">
                  <span className="font-medium text-slate-700">
                    What could break this:
                  </span>{' '}
                  {driver.fragileAssumption}
                </p>
              ) : null}
            </button>
          );
        })}
        {drivers.length === 0 ? (
          <p className="text-[12px] text-slate-500">
            No drivers under this Must-Do yet.
          </p>
        ) : null}
      </div>
    </aside>
  );
}

function ArgumentColumn({
  driver,
  mustDo,
  studyId,
}: {
  driver: GrowthDriver;
  mustDo: MustDo | undefined;
  studyId: string | null;
}) {
  const commitHref = withStudy('/simulation', studyId, {
    driver: driver.id,
    must_do: driver.mustDoId,
    prompt: 'flip-fragile-assumption',
  });
  const askHref = withStudy('/ask', studyId, { driver: driver.id });

  return (
    <section className="grid min-w-0 grid-rows-[auto_1fr_auto] bg-white">
      <div className="border-b border-slate-200 p-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
          Should we believe it, and what would change our mind?
        </p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
          {driver.title}
        </h2>
        <p className="mt-1 max-w-3xl text-[13px] leading-snug text-slate-600">
          {driver.oneLine}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ConfidencePill value={driver.confidence} />
          {mustDo ? (
            <span className="text-[11px] text-slate-500">
              Inside Must-Do · {mustDo.title}
            </span>
          ) : null}
          {driver.illustrative ? (
            <Badge
              variant="outline"
              className="border-amber-300 bg-amber-50 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-800"
            >
              Illustrative
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 p-4">
        <Block title="What we believe">
          <ul className="grid gap-2">
            {driver.hypotheses.map((item) => (
              <li
                key={item}
                className="text-[13px] leading-snug text-slate-700"
              >
                • {item}
              </li>
            ))}
          </ul>
        </Block>

        <Block title="What backs it">
          {driver.evidence.length === 0 ? (
            <p className="text-[13px] leading-snug text-slate-500">
              No evidence pointers attached yet.
            </p>
          ) : (
            <GroundedEvidence evidence={driver.evidence} studyId={studyId} />
          )}
        </Block>

        <Block title="What could break it">
          <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-3">
            <div className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" />
              <p className="text-[13px] leading-snug text-amber-900">
                {driver.fragileAssumption ||
                  'No fragile assumption recorded for this driver yet.'}
              </p>
            </div>
          </div>
        </Block>

        <Block title="Quarterly activations">
          <div className="grid grid-cols-4 gap-2">
            {QUARTERS.map((quarter) => {
              const activity = driver.activities.find(
                (a) => a.quarter === quarter,
              );
              return (
                <div
                  key={quarter}
                  className="grid gap-1.5"
                >
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    {QUARTER_LABELS[quarter]}
                  </div>
                  {activity ? (
                    <div
                      className={cn(
                        'rounded-xl border px-2 py-1.5 text-[11px] font-semibold leading-snug',
                        QUARTER_STYLES[activity.emphasis].bar,
                      )}
                    >
                      {activity.label}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] text-slate-400">
                      —
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Block>

        <Block title="Stress-tests">
          <div className="grid gap-1.5">
            {STRESS_TESTS.map((test) => {
              const href = withStudy('/simulation', studyId, {
                driver: driver.id,
                must_do: driver.mustDoId,
                prompt: test.prompt,
              });
              return (
                <Link
                  key={test.prompt}
                  href={href}
                  title={test.prompt}
                  className="inline-flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-[12px] font-medium leading-snug text-slate-800 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
                >
                  <span>{test.label}</span>
                </Link>
              );
            })}
          </div>
        </Block>

        <Block title="">
          <Link
            href={askHref}
            className="inline-flex h-9 w-fit items-center gap-2 rounded-full border border-slate-300 bg-white px-3 text-[12px] font-semibold text-slate-700 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50"
          >
            Ask Hyde about this driver
          </Link>
        </Block>
      </div>

      <div className="flex justify-end border-t border-slate-200 bg-slate-50/70 p-4">
        <Link
          href={commitHref}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-slate-950 px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
        >
          Commit decision
        </Link>
      </div>
    </section>
  );
}

function Block({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-1.5">
      {title ? (
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          {title}
        </h3>
      ) : null}
      {children}
    </section>
  );
}

// Grounded evidence base for a driver — splits its evidence pointers
// into Diageo-owned (primary) vs Public (enriching), mirroring the
// /evidence source tiering so the planner sees the simulation starts
// from approved internal evidence.
function GroundedEvidence({
  evidence,
  studyId,
}: {
  evidence: string[];
  studyId: string | null;
}) {
  const diageo = evidence.filter(
    (p) => classifyPointerTier(p).tier === 'diageo',
  );
  const publicPtrs = evidence.filter(
    (p) => classifyPointerTier(p).tier === 'public',
  );
  return (
    <div className="grid gap-2">
      <EvidenceTierRow
        label="Diageo-owned"
        tone="diageo"
        pointers={diageo}
        studyId={studyId}
        empty="No Diageo-owned source attached yet."
      />
      <EvidenceTierRow
        label="Public"
        tone="public"
        pointers={publicPtrs}
        studyId={studyId}
        empty="No public source attached yet."
      />
    </div>
  );
}

function EvidenceTierRow({
  label,
  tone,
  pointers,
  studyId,
  empty,
}: {
  label: string;
  tone: 'diageo' | 'public';
  pointers: string[];
  studyId: string | null;
  empty: string;
}) {
  return (
    <div className="grid gap-1">
      <span
        className={cn(
          'inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
          tone === 'diageo'
            ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
            : 'border-slate-200 bg-slate-50 text-slate-600',
        )}
      >
        {label}
      </span>
      {pointers.length === 0 ? (
        <p className="text-[11px] italic text-slate-400">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {pointers.map((item) => (
            <EvidenceChip key={item} pointer={item} studyId={studyId} />
          ))}
        </div>
      )}
    </div>
  );
}

function EvidenceChip({
  pointer,
  studyId,
}: {
  pointer: string;
  studyId: string | null;
}) {
  const isEncodedKey = looksLikeAssetKeyEncoded(pointer);
  const href = isEncodedKey
    ? `/evidence/${pointer}${studyId ? `?study=${studyId}` : ''}`
    : withStudy('/evidence', studyId);
  const label = isEncodedKey
    ? `Asset · ${pointer.slice(0, 10)}…`
    : humanizeAssetKey(pointer);
  return (
    <Link
      href={href}
      title={pointer}
      className="inline-flex max-w-full items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-white"
    >
      <span className="truncate">{label}</span>
    </Link>
  );
}

// Map raw evidence pointers (asset keys like
// `citation:bls:CUUR0000SA0:headline-cpi` or
// `claim:internal-sql:tailgate-occasion-volume-q3-2025`) to a planner-
// readable label. Falls back to the trimmed pointer for unknown
// families. Pure + side-effect free so it can be unit-tested.
export function humanizeAssetKey(key: string): string {
  if (!key) return key;
  // Already prose? — leave it alone (truncated for chip width).
  if (/\s/.test(key)) return truncate(key, 80);
  const parts = key.split(/[:/]/).filter(Boolean);
  if (parts.length < 2) return truncate(key, 80);
  const family = parts[0].toLowerCase();
  const FAMILY_LABELS: Record<string, string> = {
    'citation:bls': 'BLS',
    'citation:ttb': 'TTB',
    'citation:fred': 'FRED',
    'citation:internal-sql': 'Internal SQL',
    'claim:internal-sql': 'Internal SQL',
    'citation:nielsen': 'Nielsen',
    'claim:nielsen': 'Nielsen',
    'demo-placeholder': 'Illustrative',
  };
  const compoundKey =
    parts.length >= 2 ? `${family}:${parts[1].toLowerCase()}` : family;
  const compoundMatch = FAMILY_LABELS[compoundKey];
  const familyMatch = FAMILY_LABELS[family];
  const familyLabel =
    compoundMatch ??
    familyMatch ??
    (family === 'citation'
      ? 'Citation'
      : family === 'claim'
        ? 'Claim'
        : capitalize(family));
  const detailStart = compoundMatch ? 2 : 1;
  const tail = parts.slice(-1)[0] ?? '';
  const middle = parts
    .slice(detailStart, -1)
    .map((p) => p.replace(/[-_]+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');
  const prettyTail = tail.replace(/[-_]+/g, ' ').trim();
  const detail = [middle, prettyTail].filter(Boolean).join(' · ');
  const label = detail ? `${familyLabel} · ${detail}` : familyLabel;
  return truncate(label, 80);
}

function capitalize(value: string): string {
  if (!value) return value;
  return value[0].toUpperCase() + value.slice(1);
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
        'inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums',
        tone,
      )}
      title="Internal confidence based on signal strength and supporting framings"
    >
      {phraseConfidence(value)} {value}%
    </span>
  );
}

function phraseConfidence(value: number): string {
  if (value >= 75) return 'High';
  if (value >= 60) return 'Medium';
  if (value >= 40) return 'Low';
  return 'Limited';
}

function hydrateFromBackend(res: GrowthDriversResponse): {
  mustDos: MustDo[];
  drivers: GrowthDriver[];
} {
  const mustDos: MustDo[] = (res.must_dos || []).map(hydrateMustDo);
  const drivers: GrowthDriver[] = (res.drivers || []).map(hydrateDriver);
  return { mustDos, drivers };
}

function hydrateMustDo(m: MustDoDTO): MustDo {
  return {
    id: String(m.id ?? ''),
    title: String(m.title ?? ''),
    summary: String(m.summary ?? ''),
    apSplit: Number(m.ap_split ?? 0),
    confidence: Number(m.confidence ?? 0),
    focusMarkets: Array.isArray(m.focus_markets) ? m.focus_markets : [],
  };
}

function hydrateDriver(d: GrowthDriverDTO): GrowthDriver {
  return {
    id: String(d.driver_id ?? ''),
    mustDoId: String(d.must_do ?? ''),
    title: String(d.driver_name ?? ''),
    oneLine: String(d.one_line ?? ''),
    hypotheses: Array.isArray(d.hypotheses) ? d.hypotheses : [],
    activities: Array.isArray(d.activities)
      ? d.activities.map((a) => ({
          quarter: a.quarter,
          label: String(a.label ?? ''),
          emphasis: a.emphasis,
        }))
      : [],
    focusMarkets: Array.isArray(d.markets) ? d.markets : [],
    confidence: Number(
      d.confidence_value ?? parseConfidenceFromPill(d.confidence_pill) ?? 0,
    ),
    evidence: Array.isArray(d.evidence_pointers) ? d.evidence_pointers : [],
    fragileAssumption: String(d.fragile_assumption ?? ''),
    illustrative: Boolean(d.illustrative),
    assetKeyEncoded: d.asset_key_encoded || null,
  };
}

function parseConfidenceFromPill(pill: string | null | undefined): number | null {
  if (!pill) return null;
  const m = String(pill).match(/(\d{1,3})\s*%/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

// Asset keys travel as URL-safe base64 (no spaces, alphanumeric + `_` /
// `-`, optional `=` padding). Prose evidence strings always contain
// spaces or punctuation, so this discriminates cleanly.
function looksLikeAssetKeyEncoded(value: string): boolean {
  if (!value) return false;
  if (value.length < 12) return false;
  return /^[A-Za-z0-9_-]+={0,2}$/.test(value);
}

function truncate(value: string, max: number): string {
  if (!value) return value;
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

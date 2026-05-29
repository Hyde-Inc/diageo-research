'use client';

/**
 * /answer-demo — the decision-grade "perfect answer" synthesis view.
 *
 * Brings ALL of Hyde's validation layers for ONE hero claim together on a
 * single screen: the recommendation, the grounded evidence base, the
 * confidence read, the auditability chain (observed vs inferred), an
 * (illustrative) SME review, robustness across framings, and where the
 * claim lands on the permitted-use ladder.
 *
 * Hero claim: Crown Peach tailgate (study study_31c6667a40, decision
 * 8579fe808a838aef, committed by Maya Chen). Everything here mirrors the
 * REAL seeded hero data already rendered piecemeal across /decision/[id]
 * and the evidence panels — same recommendation, same 9 citations, same
 * holds-6-of-8 spec curve, same fragile assumption, same permitted-use
 * rung. The ONLY illustrative block is the SME review (no real reviewer
 * data exists yet); it carries a visible "illustrative concept" marker so
 * no one mistakes it for a validated sign-off — that honesty is the point.
 *
 * Additive only: touches no validation logic, no live page, no seed data.
 */

import Link from 'next/link';
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  Award,
  Check,
  CheckCircle2,
  Database,
  Eye,
  Gauge,
  Globe2,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  X,
} from 'lucide-react';
import { FocusCard } from '@/components/study/study-shell';
import { cn } from '@/lib/utils';

// ── REAL hero data (mirrors scripts/seed_hero_study.py) ────────────────
const HERO = {
  study: 'study_31c6667a40',
  decision: '8579fe808a838aef',
  owner: 'Maya Chen',
  committedAt: 'May 18, 2026',
  mbp: 'Crown Royal · Win Football Tailgating · Crown Peach tailgate',
  recommendation:
    'Anchor the FY27 Win Football Tailgating plan on Crown Royal Peach as the default tailgate pour, concentrating A&P in NFL-heavy tailgate priority markets alongside a grill or sauce partnership.',
  verdict:
    'Back Crown Peach as the tailgate pour in NFL-heavy markets — the read is solid enough to prioritise spend behind it, but not yet to lock budget.',
  confidence: {
    label: 'Medium',
    holds: 6,
    of: 8,
    sentence:
      'Crown Peach tailgate holds as the lead driver in 6 of 8 defensible market and occasion framings; it weakens only when the plan is read as a broad national gameday play rather than NFL-heavy tailgating.',
  },
  fragile:
    "If competitor tailgate spend in TX/WI rises 20% or more year on year, Crown Peach's structural tailgate advantage compresses 8–14 points.",
};

type Tier = 'diageo' | 'public';
type Verify = 'checkable' | 'attested';

type Source = {
  id: string;
  tier: Tier;
  label: string;
  measured: string;
  speaksTo: string;
  cantSpeakTo: string;
  verify: Verify;
};

// The real 9 citations, Diageo-owned first, public enriching.
const SOURCES: Source[] = [
  {
    id: 'S5',
    tier: 'diageo',
    label: 'Internal tailgate-occasion volume (Q3 2025)',
    measured: 'crown_peach_index=128 vs flagship_index=104 in NFL-heavy markets',
    speaksTo: 'Relative occasion demand for Crown Peach at tailgates',
    cantSpeakTo: 'Whether the gap holds once competitors raise tailgate spend',
    verify: 'checkable',
  },
  {
    id: 'S6',
    tier: 'diageo',
    label: 'CCF tequila-occasion study 2025',
    measured: 'Tailgate hosts (25–44) over-index on sweet-finish, flavored spirits',
    speaksTo: 'Why the sweet-finish occasion favours Crown Peach',
    cantSpeakTo: 'Exact volume by market — it is an occasion read, not a sales pull',
    verify: 'attested',
  },
  {
    id: 'S7',
    tier: 'diageo',
    label: 'BGS Crown Royal brand plan FY26',
    measured: 'Names tailgating + NFL gameday as priority recruitment occasions',
    speaksTo: 'Strategic intent already committed behind the occasion',
    cantSpeakTo: 'Realized FY27 outcome — it is a plan, not a result',
    verify: 'attested',
  },
  {
    id: 'S8',
    tier: 'diageo',
    label: 'Prior MBP FY26 (Crown Royal)',
    measured: 'A&P committed behind flavored-whiskey recruitment; tailgate under-spent',
    speaksTo: 'Headroom — tailgate is under-funded versus opportunity',
    cantSpeakTo: 'Whether broad national gameday occasions share that headroom',
    verify: 'attested',
  },
  {
    id: 'S9',
    tier: 'diageo',
    label: 'Prior decision: Crown Peach pilot (FY25)',
    measured: 'Three-market pilot recruited new buyers, no measurable cannibalization',
    speaksTo: 'Downside risk to flagship Crown is low',
    cantSpeakTo: 'National scale-up effects beyond three pilot markets',
    verify: 'attested',
  },
  {
    id: 'S3',
    tier: 'public',
    label: 'TTB Distilled Spirits Statistical Release, Q3 2025',
    measured: 'US removals +1.1% YoY; flavored whiskey outpaced flagship',
    speaksTo: 'Category tailwind for flavored whiskey',
    cantSpeakTo: 'Anything Crown-Peach- or occasion-specific',
    verify: 'checkable',
  },
  {
    id: 'S1',
    tier: 'public',
    label: 'BLS CPI-U, all items (CUUR0000SA0)',
    measured: '2025 headline CPI-U +2.9% YoY',
    speaksTo: 'Macro price backdrop for the planning window',
    cantSpeakTo: 'Spirits-specific demand or occasion mix',
    verify: 'checkable',
  },
  {
    id: 'S2',
    tier: 'public',
    label: 'BLS CPI distilled spirits at home (CUUR0000SEFW01)',
    measured: 'Distilled-spirits-at-home CPI +1.4% YoY, below headline',
    speaksTo: 'Spirits stayed affordable relative to inflation',
    cantSpeakTo: 'Brand- or occasion-level pricing power',
    verify: 'checkable',
  },
  {
    id: 'S4',
    tier: 'public',
    label: 'US Census Monthly Retail Trade — beverage stores',
    measured: 'Beer/wine/liquor store sales +3.2% YoY',
    speaksTo: 'Off-premise channel demand was growing',
    cantSpeakTo: 'On-premise tailgate occasion or brand split',
    verify: 'checkable',
  },
];

// The real 8 spec-curve cells (occasion × market × season).
type CellStatus = 'agree' | 'weaker' | 'flip';
type Cell = { occasion: string; market: string; season: string; status: CellStatus };
const CELLS: Cell[] = [
  { occasion: 'Tailgate', market: 'NFL-heavy', season: 'Regular', status: 'agree' },
  { occasion: 'Tailgate', market: 'NFL-heavy', season: 'Full season', status: 'agree' },
  { occasion: 'Tailgate', market: 'National', season: 'Regular', status: 'agree' },
  { occasion: 'Tailgate', market: 'National', season: 'Full season', status: 'agree' },
  { occasion: 'Gameday', market: 'NFL-heavy', season: 'Regular', status: 'agree' },
  { occasion: 'Gameday', market: 'NFL-heavy', season: 'Full season', status: 'agree' },
  { occasion: 'Gameday', market: 'National', season: 'Regular', status: 'weaker' },
  { occasion: 'Gameday', market: 'National', season: 'Full season', status: 'flip' },
];

// ── ILLUSTRATIVE ONLY — no real reviewer data exists yet ───────────────
const ILLUSTRATIVE_SME = {
  reviewers: [
    { name: 'Category & Insights SME', focus: 'Occasion demand read' },
    { name: 'Commercial Planning SME', focus: 'Market concentration & A&P' },
  ],
  rubric: [
    { dim: 'Evidence grounding', score: 4 },
    { dim: 'Occasion logic', score: 4 },
    { dim: 'Market read', score: 3 },
    { dim: 'Claims / reg safety', score: 5 },
  ],
  note: 'Concentrate the budget read on NFL-heavy metros; treat the national framing as a watch-item, not a base case.',
};

export default function AnswerDemoPage() {
  const composite = (
    ILLUSTRATIVE_SME.rubric.reduce((a, r) => a + r.score, 0) /
    ILLUSTRATIVE_SME.rubric.length
  ).toFixed(1);

  return (
    <div className="min-h-svh bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.10),transparent_32rem),linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)] pb-16 font-sans text-slate-950">
      <header className="border-b border-slate-200/80 bg-white/80 px-4 py-4 shadow-sm shadow-slate-950/[0.03] backdrop-blur sm:px-6">
        <div className="mx-auto flex w-full max-w-[1500px] flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <Link
              href="/"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 transition-colors hover:text-slate-900"
            >
              <ArrowRight className="h-3 w-3 rotate-180" />
              Workbench
            </Link>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              <Award className="h-3 w-3" />
              Decision-grade answer · the whole validation stack on one screen
            </div>
            <h1 className="mt-1 text-balance text-xl font-semibold leading-snug tracking-tight text-slate-950 sm:text-2xl">
              Crown Peach is the tailgate pour to back — good enough to
              prioritise spend, not yet to lock budget.
            </h1>
            <p className="mt-1 max-w-3xl text-[12px] leading-snug text-slate-500">
              One claim, every layer together: the recommendation, its
              grounded evidence, how confident we are, what is observed vs
              inferred, expert review, how it holds across framings, and what
              it is actually safe to decide with.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-slate-300 bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
              Study {HERO.study.slice(0, 14)} · decision {HERO.decision.slice(0, 8)}
            </span>
            <span className="text-[10px] text-slate-400">
              Committed by {HERO.owner} · {HERO.committedAt}
            </span>
          </div>
        </div>
      </header>

      <main className="px-4 py-6 sm:px-6">
        <div className="mx-auto grid w-full max-w-[1500px] gap-4">
          {/* 01 · The answer (dark accent panel) */}
          <section className="grid gap-4 rounded-3xl border border-slate-900 bg-slate-950 p-6 text-slate-50 shadow-sm shadow-slate-950/10 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <div className="grid content-start gap-3">
              <SectionEyebrow n="01" label="The answer" tone="dark" icon={Award} />
              <p className="text-balance text-lg font-semibold leading-snug tracking-tight text-white sm:text-xl">
                {HERO.recommendation}
              </p>
              <p className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-[13px] leading-snug text-slate-200">
                <span className="font-semibold text-white">In plain terms — </span>
                {HERO.verdict}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2.5 py-0.5 font-semibold uppercase tracking-wide text-emerald-300">
                  <CheckCircle2 className="h-3 w-3" />
                  Good for: prioritising options
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 font-semibold uppercase tracking-wide text-slate-300">
                  Not yet budget-grade
                </span>
                <span>{HERO.mbp}</span>
              </div>
            </div>
            {/* Confidence read-out, embedded so the headline carries its own caveat */}
            <div className="grid content-start gap-2 rounded-2xl border border-white/10 bg-white/5 p-4">
              <SectionEyebrow n="03" label="Confidence level" tone="dark" icon={Gauge} />
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold tabular-nums text-white">
                  {HERO.confidence.label}
                </span>
                <span className="text-[12px] font-medium text-slate-300">
                  holds {HERO.confidence.holds} of {HERO.confidence.of} framings
                </span>
              </div>
              <div className="flex gap-1">
                {Array.from({ length: HERO.confidence.of }).map((_, i) => (
                  <span
                    key={i}
                    className={cn(
                      'h-2 flex-1 rounded-full',
                      i < HERO.confidence.holds ? 'bg-emerald-400' : 'bg-orange-400/70',
                    )}
                  />
                ))}
              </div>
              <p className="text-[12px] leading-snug text-slate-300">
                {HERO.confidence.sentence}
              </p>
            </div>
          </section>

          {/* Two-column synthesis grid */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* LEFT column */}
            <div className="grid content-start gap-4">
              <EvidenceBaseCard />
              <RobustnessCard />
            </div>
            {/* RIGHT column */}
            <div className="grid content-start gap-4">
              <AuditabilityCard />
              <SmeReviewCard composite={composite} />
            </div>
          </div>

          {/* 07 · Recommended use (full-width ladder) */}
          <RecommendedUseCard />

          <p className="text-[11px] leading-snug text-slate-500">
            Verdict colours match the workbench: emerald = holds, amber =
            weakens, orange = flips. Every layer above except the SME review
            is the real seeded hero record (same recommendation, citations,
            spec curve, and permitted-use rung as <span className="font-mono text-[10px]">/decision/{HERO.decision.slice(0, 8)}</span>).
            The SME review is an illustrative concept — real reviewer sign-off
            is what would move this past &ldquo;prioritise&rdquo; toward budget-grade.
          </p>
        </div>
      </main>
    </div>
  );
}

// ── 02 · Evidence base ─────────────────────────────────────────────────
function EvidenceBaseCard() {
  const diageo = SOURCES.filter((s) => s.tier === 'diageo');
  const publicSrc = SOURCES.filter((s) => s.tier === 'public');
  const checkable = SOURCES.filter((s) => s.verify === 'checkable').length;
  const attested = SOURCES.filter((s) => s.verify === 'attested').length;
  return (
    <FocusCard className="grid gap-3">
      <SectionEyebrow n="02" label="Evidence base" icon={ShieldCheck} />
      <p className="text-[12px] leading-snug text-slate-500">
        Diageo-owned sources are primary; public sources enrich, they don&apos;t
        replace them. Of {SOURCES.length},{' '}
        <span className="font-semibold text-emerald-700">{checkable} checkable</span>{' '}
        (the verifier re-ran them) and{' '}
        <span className="font-semibold text-indigo-700">{attested} owner-attested</span>{' '}
        (taken on the owner&apos;s word).
      </p>
      <TierBlock
        tone="diageo"
        Icon={Database}
        title="Diageo-owned"
        caption="Approved internal evidence — the simulation starts here."
        sources={diageo}
      />
      <TierBlock
        tone="public"
        Icon={Globe2}
        title="Public"
        caption="External context that enriches, but isn't treated as equivalent."
        sources={publicSrc}
      />
    </FocusCard>
  );
}

function TierBlock({
  tone,
  Icon,
  title,
  caption,
  sources,
}: {
  tone: Tier;
  Icon: typeof Database;
  title: string;
  caption: string;
  sources: Source[];
}) {
  const accent =
    tone === 'diageo' ? 'border-indigo-200 bg-indigo-50/60' : 'border-slate-200 bg-slate-50/70';
  const chip = tone === 'diageo' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-200 text-slate-600';
  return (
    <section className={cn('grid gap-2 rounded-2xl border p-3', accent)}>
      <header className="flex flex-wrap items-center gap-2">
        <Icon className={cn('h-3.5 w-3.5', tone === 'diageo' ? 'text-indigo-600' : 'text-slate-500')} />
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-700">
          {title}
        </span>
        <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums', chip)}>
          {sources.length}
        </span>
        <span className="text-[11px] text-slate-500">{caption}</span>
      </header>
      <ul className="grid gap-1.5">
        {sources.map((s) => (
          <li key={s.id} className="rounded-xl border border-white bg-white px-3 py-2 shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
              <p className="text-[12px] font-semibold text-slate-900">
                <span className="mr-1 font-mono text-[9px] font-semibold tracking-wider text-slate-400">
                  [{s.id}]
                </span>
                {s.label}
              </p>
              <VerifyChip verify={s.verify} />
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-slate-700">
              <span className="font-medium text-slate-500">Measured:</span> {s.measured}
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-slate-600">
              <span className="font-medium text-emerald-700">Speaks to:</span> {s.speaksTo}
            </p>
            <p className="text-[11px] leading-snug text-slate-500">
              <span className="font-medium text-orange-600">Can&apos;t speak to:</span> {s.cantSpeakTo}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function VerifyChip({ verify }: { verify: Verify }) {
  return verify === 'checkable' ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
      <CheckCircle2 className="h-3 w-3" />
      Checkable
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
      Owner-attested
    </span>
  );
}

// ── 04 · Auditability (observed vs inferred + chain) ───────────────────
function AuditabilityCard() {
  return (
    <FocusCard className="grid gap-3">
      <SectionEyebrow n="04" label="Auditability" icon={Eye} />
      <p className="text-[12px] leading-snug text-slate-500">
        Hyde separates measured facts from grounded inference, so each can be
        challenged on its own terms.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <section className="grid content-start gap-2 rounded-2xl border border-blue-200 bg-blue-50/60 p-3">
          <header className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-blue-700" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-800">
              Observed in the data
            </span>
          </header>
          <p className="text-[11px] leading-snug text-slate-700">
            <span className="font-mono text-[10px] font-semibold text-slate-500">[S5]</span> Crown
            Peach index <span className="font-semibold">128</span> vs flagship{' '}
            <span className="font-semibold">104</span> at NFL-heavy tailgates — re-run by the
            verifier.
          </p>
          <p className="text-[11px] leading-snug text-slate-700">
            Public stats <span className="font-mono text-[10px] text-slate-500">[S1–S4]</span>{' '}
            confirm a flavored-whiskey category tailwind, all re-extracted.
          </p>
        </section>
        <section className="grid content-start gap-2 rounded-2xl border border-violet-200 bg-violet-50/60 p-3">
          <header className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-700" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-violet-800">
              Inferred by grounded simulation
            </span>
          </header>
          <p className="text-[11px] leading-snug text-slate-700">
            The panel reads those measurements as the signal behind the call, and keeps the call
            only because it survives the framings it was stress-tested across.
          </p>
        </section>
      </div>
      {/* Evidence chain: inputs → judgment → conclusion */}
      <div className="grid gap-1">
        <ChainStep tone="fact" label="Starts from — checkable facts">
          <span className="text-[11px] leading-snug text-slate-700">
            <span className="font-mono text-[10px] font-semibold text-slate-500">[S5]</span> index
            128 vs 104 · <span className="font-mono text-[10px] font-semibold text-slate-500">[S6]</span>{' '}
            sweet-finish occasion over-index · <span className="font-mono text-[10px] font-semibold text-slate-500">[S9]</span>{' '}
            FY25 pilot, no cannibalization.
          </span>
        </ChainStep>
        <ChainConnector />
        <ChainStep tone="judgment" label="The leap — a judgment, not a measurement">
          <span className="text-[11px] leading-snug text-slate-700">
            A 24-point occasion gap plus committed intent and a clean pilot is enough to name Crown
            Peach the default tailgate pour — provided it holds across framings.{' '}
            <span className="text-slate-500">
              This middle step is reasoning, not a re-runnable number — it is where judgment enters.
            </span>
          </span>
        </ChainStep>
        <ChainConnector />
        <ChainStep tone="conclusion" label="Concludes">
          <span className="text-[12px] font-medium leading-snug text-slate-900">
            &ldquo;Anchor the FY27 plan on Crown Peach as the default tailgate pour in NFL-heavy
            markets.&rdquo;
          </span>
        </ChainStep>
      </div>
    </FocusCard>
  );
}

function ChainStep({
  tone,
  label,
  children,
}: {
  tone: 'fact' | 'judgment' | 'conclusion';
  label: string;
  children: React.ReactNode;
}) {
  const accent =
    tone === 'fact'
      ? 'border-emerald-200 bg-emerald-50/70'
      : tone === 'judgment'
        ? 'border-amber-200 bg-amber-50/70'
        : 'border-violet-200 bg-white';
  const tag =
    tone === 'fact' ? 'text-emerald-700' : tone === 'judgment' ? 'text-amber-700' : 'text-violet-700';
  return (
    <div className={cn('grid gap-1 rounded-xl border px-3 py-2', accent)}>
      <span className={cn('text-[10px] font-semibold uppercase tracking-[0.12em]', tag)}>{label}</span>
      {children}
    </div>
  );
}

function ChainConnector() {
  return (
    <div className="grid place-items-center text-slate-300">
      <ArrowDown className="h-3 w-3" />
    </div>
  );
}

// ── 06 · Robustness (compact spec curve) ───────────────────────────────
function RobustnessCard() {
  const counts = {
    agree: CELLS.filter((c) => c.status === 'agree').length,
    weaker: CELLS.filter((c) => c.status === 'weaker').length,
    flip: CELLS.filter((c) => c.status === 'flip').length,
  };
  return (
    <FocusCard className="grid gap-3">
      <SectionEyebrow n="06" label="Robustness" icon={Target} />
      <p className="text-[12px] leading-snug text-slate-500">
        Re-run across 8 defensible framings — occasion lens × market definition × season window.{' '}
        <span className="font-semibold text-emerald-700">{counts.agree} hold</span> ·{' '}
        <span className="font-semibold text-amber-700">{counts.weaker} weakens</span> ·{' '}
        <span className="font-semibold text-orange-700">{counts.flip} flips</span>.
      </p>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {CELLS.map((c, i) => (
          <CellChip key={i} cell={c} />
        ))}
      </div>
      <div className="flex items-start gap-2 rounded-2xl border border-orange-200 bg-orange-50/70 px-3 py-2.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-600" />
        <p className="text-[12px] leading-snug text-slate-700">
          <span className="font-semibold text-orange-800">The fragile cut: Gameday × National.</span>{' '}
          Under a broad national gameday read the tailgate edge is diluted by stadium-suite and
          sports-bar occasions — that is the one framing where the call weakens, then flips over the
          full season.
        </p>
      </div>
      <p className="text-[11px] leading-snug text-slate-500">
        <span className="font-medium text-slate-600">What could break this:</span> {HERO.fragile}
      </p>
    </FocusCard>
  );
}

function CellChip({ cell }: { cell: Cell }) {
  const meta =
    cell.status === 'agree'
      ? { cls: 'border-emerald-200 bg-emerald-50 text-emerald-700', Icon: Check, label: 'Holds' }
      : cell.status === 'weaker'
        ? { cls: 'border-amber-200 bg-amber-50 text-amber-700', Icon: AlertTriangle, label: 'Weakens' }
        : { cls: 'border-orange-200 bg-orange-50 text-orange-700', Icon: X, label: 'Flips' };
  return (
    <div className={cn('grid gap-0.5 rounded-xl border px-2.5 py-2', meta.cls)}>
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide">
        <meta.Icon className="h-3 w-3" />
        {meta.label}
      </span>
      <span className="text-[10px] leading-tight text-slate-600">
        {cell.occasion} · {cell.market}
      </span>
      <span className="text-[9px] leading-tight text-slate-400">{cell.season}</span>
    </div>
  );
}

// ── 05 · Expert review (ILLUSTRATIVE) ──────────────────────────────────
function SmeReviewCard({ composite }: { composite: string }) {
  return (
    <FocusCard className="grid gap-3 border-amber-200 bg-amber-50/40">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionEyebrow n="05" label="Expert review (SME)" icon={Users} />
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
          Illustrative concept — hypothetical
        </span>
      </div>
      <p className="text-[12px] leading-snug text-amber-900">
        <span className="font-semibold">Illustrative.</span> No real reviewer sign-off exists yet —
        this shows the shape of the SME layer once category and commercial experts score the answer.
        It is not a validated review.
      </p>
      <div className="grid gap-1.5">
        {ILLUSTRATIVE_SME.reviewers.map((r) => (
          <div
            key={r.name}
            className="flex items-center justify-between rounded-xl border border-white bg-white px-3 py-2 shadow-sm"
          >
            <span className="text-[12px] font-semibold text-slate-900">{r.name}</span>
            <span className="text-[11px] text-slate-500">{r.focus}</span>
          </div>
        ))}
      </div>
      <div className="grid gap-1.5 rounded-2xl border border-amber-200 bg-white/80 p-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
            Rubric score
          </span>
          <span className="text-[12px] font-semibold tabular-nums text-slate-900">
            {composite} / 5 composite
          </span>
        </div>
        {ILLUSTRATIVE_SME.rubric.map((r) => (
          <div key={r.dim} className="flex items-center gap-2">
            <span className="w-36 shrink-0 text-[11px] text-slate-600">{r.dim}</span>
            <div className="flex flex-1 gap-0.5">
              {Array.from({ length: 5 }).map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    'h-1.5 flex-1 rounded-full',
                    i < r.score ? 'bg-amber-500' : 'bg-amber-100',
                  )}
                />
              ))}
            </div>
            <span className="w-8 shrink-0 text-right text-[11px] font-semibold tabular-nums text-slate-700">
              {r.score}/5
            </span>
          </div>
        ))}
      </div>
      <p className="text-[12px] leading-snug text-slate-700">
        <span className="font-medium text-slate-500">Reviewer note (illustrative):</span>{' '}
        {ILLUSTRATIVE_SME.note}
      </p>
    </FocusCard>
  );
}

// ── 07 · Recommended use (permitted-use ladder) ────────────────────────
const PERMITTED_USE = ['Open hypotheses', 'Prioritise options', 'Recommend', 'Budget / pricing / portfolio'];
const CURRENT_RUNG = 1; // holds 6/8 (ratio 0.75 < 0.85) + a live fragile assumption → prioritise

function RecommendedUseCard() {
  return (
    <FocusCard className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionEyebrow n="07" label="Recommended use" icon={Gauge} />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[12px] font-semibold text-emerald-800">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Good for: prioritising options — NOT yet budget-grade
        </span>
      </div>
      <ol className="flex flex-wrap items-stretch gap-1.5">
        {PERMITTED_USE.map((label, idx) => {
          const reached = idx <= CURRENT_RUNG;
          const current = idx === CURRENT_RUNG;
          return (
            <li key={label} className="flex items-center gap-1.5">
              <span
                className={cn(
                  'inline-flex items-center rounded-xl border px-2.5 py-1 text-[11px] font-semibold leading-snug',
                  current
                    ? 'border-slate-900 bg-slate-950 text-white shadow-sm'
                    : reached
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-dashed border-slate-200 bg-white text-slate-400',
                )}
              >
                {label}
                {idx > CURRENT_RUNG ? (
                  <span className="ml-1 text-[9px] uppercase tracking-wide">not yet</span>
                ) : null}
              </span>
              {idx < PERMITTED_USE.length - 1 ? (
                <ArrowRight className="h-3 w-3 text-slate-300" />
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="text-[12px] leading-snug text-slate-600">
        It holds in 6 of 8 framings, but a load-bearing assumption (competitor tailgate spend) is
        still untested and there is no outcome backtest yet — enough to prioritise options, not yet
        to commit budget.
      </p>
      <div className="flex items-start gap-2 rounded-2xl border border-blue-200 bg-blue-50/50 px-3 py-2.5">
        <Target className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-700" />
        <p className="text-[12px] leading-snug text-slate-700">
          <span className="font-semibold text-blue-800">What would upgrade it:</span> a targeted
          check on competitor TX/WI tailgate spend plus a real SME sign-off — the smallest evidence
          that would move this past &ldquo;prioritise&rdquo; toward budget-grade.
        </p>
      </div>
    </FocusCard>
  );
}

// ── shared eyebrow ─────────────────────────────────────────────────────
function SectionEyebrow({
  n,
  label,
  icon: Icon,
  tone = 'light',
}: {
  n: string;
  label: string;
  icon: typeof Award;
  tone?: 'light' | 'dark';
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em]',
        tone === 'dark' ? 'text-slate-400' : 'text-slate-500',
      )}
    >
      <span
        className={cn(
          'inline-flex h-4 min-w-4 items-center justify-center rounded px-1 font-mono text-[9px]',
          tone === 'dark' ? 'bg-white/10 text-slate-200' : 'bg-slate-100 text-slate-500',
        )}
      >
        {n}
      </span>
      <Icon className="h-3.5 w-3.5" />
      {label}
    </div>
  );
}

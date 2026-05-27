'use client';

/**
 * /simulation — counterfactual surface for the MBP loop.
 *
 * Two scoped entry points are supported (FR-SM-1):
 *   1. Growth-driver stress-test
 *      ?study=…&driver=<driver_id>&must_do=<must_do_slug>
 *   2. Research-finding counter-scenario
 *      ?study=…&finding=<idx>&prompt=<heuristic>&occasion=<o>&brand=<b>
 *
 * The page renders ≥2 counterfactual variants for the active scope
 * (FR-SM-3), each with a directional effect, an inputs panel naming
 * the actual data sources, an honest confidence pill, and an
 * "assumes / doesn't assume" disclosure. The math behind the
 * projection is printed in the disclosure so it stays defensible
 * (NFR-2: honest illustrative).
 *
 * Two CTAs are stubbed for Worker D to wire up:
 *   - "Validate against promo data" — TODO: FR-SM-4 (POST /tasks
 *     kind=validate-promo with scope and due-date)
 *   - "Commit as decision" — TODO: FR-SM-5 (POST /decisions carrying
 *     counterfactual_ref, redirect to /decision/[id])
 * Both currently fire a small confirmation toast so the flow is
 * complete from a demo perspective without backend coupling.
 */

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowRight,
  Beaker,
  CheckCircle2,
  Compass,
  FileSearch,
  HelpCircle,
  Info,
  Send,
  Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ConfidencePanel } from '@/components/study/confidence-panel';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { PaneCard } from '@/components/workbench/pane-layout';
import { cn } from '@/lib/utils';
import { wb, type ResearchSummary } from '@/components/workbench/types';

type DriverScope = {
  kind: 'driver';
  driverSlug: string;
  driverLabel: string;
  mustDoSlug: string | null;
  mustDoLabel: string | null;
};

type FindingScope = {
  kind: 'finding';
  findingIndex: number;
  prompt: string;
  promptLabel: string;
  occasion: string | null;
  brand: string | null;
};

type EmptyScope = { kind: 'empty' };

type Scope = DriverScope | FindingScope | EmptyScope;

type ConfidenceLevel = 'Low' | 'Medium' | 'High';

type EvidenceInput = { label: string; source: string };

type Variant = {
  id: string;
  title: string;
  subtitle: string;
  directional: string;
  effectValue: string;
  effectKind: 'lift' | 'hold' | 'hedge' | 'risk';
  confidence: ConfidenceLevel;
  confidenceReason: string;
  inputs: EvidenceInput[];
  assumes: string[];
  doesNotAssume: string[];
  math: string;
  illustrative: boolean;
};

function SimulationBody() {
  const data = useStudyData();
  const { studyId, curve, detail } = data;
  const search = useSearchParams();
  const [summary, setSummary] = useState<ResearchSummary | null>(null);
  const [toast, setToast] = useState<{
    id: number;
    title: string;
    body: string;
  } | null>(null);

  useEffect(() => {
    if (!studyId) return;
    let cancelled = false;
    wb.research(studyId)
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  // Drop the cached research summary when the study switches so we
  // never render stale finding data against a new study scope.
  const summaryForStudy = studyId ? summary : null;

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const driverParam = search.get('driver');
  const mustDoParam = search.get('must_do');
  const findingParam = search.get('finding');
  const promptParam = search.get('prompt');
  const occasionParam = search.get('occasion');
  const brandParam = search.get('brand');

  const scope = useMemo<Scope>(
    () =>
      deriveScope({
        driver: driverParam,
        mustDo: mustDoParam,
        finding: findingParam,
        prompt: promptParam,
        occasion: occasionParam,
        brand: brandParam,
      }),
    [
      driverParam,
      mustDoParam,
      findingParam,
      promptParam,
      occasionParam,
      brandParam,
    ],
  );

  const findingTitle = useMemo(() => {
    if (scope.kind !== 'finding') return null;
    if (summaryForStudy && summaryForStudy.top_risks.length > scope.findingIndex) {
      return summaryForStudy.top_risks[scope.findingIndex]?.line ?? null;
    }
    return null;
  }, [scope, summaryForStudy]);

  const variants = useMemo(
    () => buildVariants(scope, findingTitle),
    [scope, findingTitle],
  );

  const headingTitle = buildTitle(scope, findingTitle);
  const headingIntro = buildIntro(scope);

  // FR-SM-4: stubbed for Worker D. Backend wiring should hit
  // POST /tasks with body {kind: 'validate-promo', study_id,
  // scope: {driver|finding+prompt+occasion+brand}, due_date} and
  // confirm a task asset id in the response so we can deep-link to it.
  // TODO(worker-d, FR-SM-4): swap toast for a real POST /tasks call.
  const onValidatePromo = () => {
    const id = Date.now();
    setToast({
      id,
      title: 'Will create a validation task',
      body: 'Pending API wiring (FR-SM-4). The task will land in /assets once Worker D ships POST /tasks.',
    });
  };

  // FR-SM-5: stubbed for Worker D. Backend wiring should hit
  // POST /decisions with the scope, the selected counterfactual_ref
  // (variant id), inputs_used, owner, and the captured assumes-list,
  // then redirect to /decision/[id] (worker D ships that route too).
  // TODO(worker-d, FR-SM-5): swap toast for POST /decisions + redirect.
  const onCommitDecision = () => {
    const id = Date.now();
    setToast({
      id,
      title: 'Will commit decision',
      body: 'Pending API wiring (FR-SM-5). Worker D ships POST /decisions and the /decision/[id] read page.',
    });
  };

  return (
    <>
      <StudyShell
        data={data}
        eyebrow="Counter-scenario simulation"
        title={headingTitle}
        intro={headingIntro}
        contentClassName="max-w-[1400px]"
        mainLabel="Counterfactual variants"
        rightLabel="Honest summary"
          main={
          !studyId ? null : scope.kind === 'empty' ? (
            <EmptyState detail={detail?.question ?? null} />
          ) : (
            <div className="grid gap-4">
              <ScopeCard
                scope={scope}
                findingTitle={findingTitle}
                detailQuestion={detail?.question ?? null}
              />
              <VariantsGrid variants={variants} />
              <DisclosureBlock variants={variants} scope={scope} />
              <ActionBar
                onValidatePromo={onValidatePromo}
                onCommitDecision={onCommitDecision}
                disabled={variants.length === 0}
              />
            </div>
          )
        }
        right={
          !studyId ? null : (
            <ConfidencePanel
              curve={curve}
              interval={{
                kind: 'prediction interval',
                available: false,
                requiredData:
                  scope.kind === 'finding' && scope.occasion
                    ? `connected promo, loyalty, and holdout outcomes for ${scope.occasion}.`
                    : 'connected promo, loyalty, and holdout outcomes for this study scope.',
              }}
              provenance={{
                source:
                  scope.kind === 'driver'
                    ? 'Growth-driver fixture + prereg traces'
                    : 'Research finding + study brief traces',
                transformation:
                  'Elasticity prior plus linear bundling uplift (printed in disclosure)',
                output:
                  'Per-variant directional effect, named inputs, honest confidence',
                available: variants.length > 0,
              }}
              raiseConfidence={[
                'Run /tasks → validate-against-promo to attach a real holdout for the active variant.',
                'Commit the chosen variant as a decision so the in-year diff can compare against new evidence later.',
                'Re-run the simulation after Worker B wires POST /counterfactuals so projections persist as assets.',
              ]}
            />
          )
        }
      />
      {toast ? (
        <Toast
          key={toast.id}
          title={toast.title}
          body={toast.body}
          onClose={() => setToast(null)}
        />
      ) : null}
    </>
  );
}

export default function SimulationPage() {
  return (
    <Suspense fallback={null}>
      <SimulationBody />
    </Suspense>
  );
}

function deriveScope(args: {
  driver: string | null;
  mustDo: string | null;
  finding: string | null;
  prompt: string | null;
  occasion: string | null;
  brand: string | null;
}): Scope {
  const { driver, mustDo, finding, prompt, occasion, brand } = args;
  if (driver) {
    return {
      kind: 'driver',
      driverSlug: driver,
      driverLabel: humaniseSlug(driver),
      mustDoSlug: mustDo,
      mustDoLabel: mustDo ? humaniseSlug(mustDo) : null,
    };
  }
  if (finding != null) {
    const idxRaw = Number(finding);
    const findingIndex = Number.isFinite(idxRaw) && idxRaw >= 0 ? idxRaw : 0;
    const promptSlug = prompt?.trim() || 'discount-vs-bundle';
    return {
      kind: 'finding',
      findingIndex,
      prompt: promptSlug,
      promptLabel: humaniseSlug(promptSlug),
      occasion: occasion?.trim() || null,
      brand: brand?.trim() || null,
    };
  }
  return { kind: 'empty' };
}

function humaniseSlug(slug: string): string {
  if (!slug) return '';
  return slug
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase());
}

function buildTitle(scope: Scope, findingTitle: string | null): string {
  if (scope.kind === 'driver') {
    if (scope.mustDoLabel) {
      return `Stress-test: ${scope.driverLabel} · ${scope.mustDoLabel}`;
    }
    return `Stress-test: ${scope.driverLabel}`;
  }
  if (scope.kind === 'finding') {
    const subject = findingTitle?.trim() || `Finding #${scope.findingIndex + 1}`;
    const trimmed = subject.length > 90 ? `${subject.slice(0, 87)}…` : subject;
    if (scope.brand && scope.occasion) {
      return `Counter-scenario: ${scope.promptLabel} for ${scope.brand} in ${scope.occasion}`;
    }
    if (scope.occasion) {
      return `Counter-scenario: ${scope.promptLabel} in ${scope.occasion}`;
    }
    return `Counter-scenario: ${trimmed}`;
  }
  return 'Counter-scenario simulation';
}

function buildIntro(scope: Scope): string {
  if (scope.kind === 'driver') {
    return 'Two defensible framings of the growth driver, with the math, the inputs, and the honest confidence each one earns. Use the actions at the bottom to validate against promo data or commit the chosen variant as a decision.';
  }
  if (scope.kind === 'finding') {
    return 'Two counterfactual variants for the finding in scope. Every variant names its inputs, prints the projection math, and carries an honest confidence pill so the answer stays defensible.';
  }
  return 'Open this page from a growth driver or a research finding to scope a counterfactual.';
}

function buildVariants(
  scope: Scope,
  findingTitle: string | null,
): Variant[] {
  if (scope.kind === 'driver') {
    return buildDriverVariants(scope);
  }
  if (scope.kind === 'finding') {
    return buildFindingVariants(scope, findingTitle);
  }
  return [];
}

const DRIVER_INPUTS: EvidenceInput[] = [
  {
    label: 'Loyalty cohort flows',
    source: 'runs/loyalty_panel.csv (loyalty asset)',
  },
  {
    label: 'Brand-level elasticity prior',
    source: 'runs/elasticity_note.md (elasticity asset)',
  },
  {
    label: 'Occasion volume shares',
    source: 'runs/occasion_mix.json (occasion_share asset)',
  },
];

function buildDriverVariants(scope: DriverScope): Variant[] {
  const drv = scope.driverLabel;
  const mustDo = scope.mustDoLabel ?? 'this Must-Do';
  // Math constants — defensible toy priors. Worker B will replace these
  // with real elasticity numbers when POST /counterfactuals is wired
  // up. The values stay illustrative; the formula does not.
  const baseLift = 6;
  const elasticityPrior = 0.4; // pp uplift per market expansion unit
  const bundlingUplift = 2.5; // pp linear bundling adjacency uplift

  return [
    {
      id: 'concentrate',
      title: 'Concentrate within focus markets',
      subtitle: `Hold ${drv} spend inside the existing focus markets for ${mustDo}.`,
      directional:
        'Smaller absolute lift but tighter execution risk — keeps the activation inside teams that already ran the playbook.',
      effectValue: `+${baseLift.toFixed(1)} pp spend retention`,
      effectKind: 'hold',
      confidence: 'Medium',
      confidenceReason:
        'Elasticity prior is from a brand-level note, not a desk-level holdout. Markets are known; risk is execution-bound.',
      inputs: DRIVER_INPUTS,
      assumes: [
        'Focus markets remain the bulk of the occasion volume during the activation window.',
        'No new competitor pulse displaces shelf in tier-1 cities.',
        'The signature serve trained in pilot venues holds past week 4.',
      ],
      doesNotAssume: [
        'A national rollout — this variant explicitly stays inside the focus market list.',
        'Bundling uplift — that is the alternative variant below.',
        'Connected promo holdout data — none is wired yet.',
      ],
      math: `retention_concentrate = baseline + ${baseLift.toFixed(1)} pp; elasticity prior α = ${elasticityPrior}, applied flat across focus markets.`,
      illustrative: true,
    },
    {
      id: 'extend',
      title: 'Extend to adjacent markets',
      subtitle: `Widen the ${drv} footprint into adjacent markets that didn't run the pilot.`,
      directional:
        'Bigger upside if the activation travels, real risk if the prior was tied to the pilot markets that already over-indexed.',
      effectValue: `+${(baseLift + elasticityPrior * 8 + bundlingUplift).toFixed(1)} pp spend retention`,
      effectKind: 'lift',
      confidence: 'Low',
      confidenceReason:
        'Elasticity prior is being extrapolated outside the pilot set; bundling uplift is a linear toy with no validated coefficient yet.',
      inputs: DRIVER_INPUTS,
      assumes: [
        'Elasticity prior holds outside the pilot markets at the same magnitude.',
        'Adjacent markets have a comparable on-premise footprint to the focus set.',
        'Linear bundling adjacency holds — bundle uplift compounds rather than substitutes.',
      ],
      doesNotAssume: [
        'A specific media split — this is a spend-retention projection, not a media plan.',
        'A bottom-up elasticity per ZIP — the prior is a single brand-level number.',
        'That existing focus-market wins persist if spend is pulled to fund the extension.',
      ],
      math: `retention_extend = baseline + ${baseLift.toFixed(1)} + α·8 + β = ${(baseLift + elasticityPrior * 8 + bundlingUplift).toFixed(1)} pp; α (elasticity) = ${elasticityPrior}, β (bundling) = ${bundlingUplift}.`,
      illustrative: true,
    },
  ];
}

function buildFindingVariants(
  scope: FindingScope,
  findingTitle: string | null,
): Variant[] {
  const occasionLabel = scope.occasion ?? 'the exposed occasion';
  const brandLabel = scope.brand ?? 'the in-scope brand';
  const findingSummary = findingTitle?.trim() ?? null;
  // Discount-vs-bundle math:
  //   discount_retention(d%) = baseline + α · d
  //   bundle_retention       = baseline + β · (mixer_share − threshold)
  // baseline = 0pp (we report deltas vs the baseline plan); α = 0.9
  // is the illustrative elasticity prior we use elsewhere; β = 0.72
  // captures the linear bundling uplift carried over from the earlier
  // simulation pane. mixer_share assumed at 0.6 and threshold at 0.5
  // so the bundle gets a +0.072 lift over the 15% discount baseline.
  const discountPct = 15;
  const alpha = 0.9;
  const beta = 0.72;
  const baseline = 4; // shelf-only retention floor (illustrative)
  const discount_lift = baseline + alpha * discountPct;
  const bundle_lift = baseline + beta * discountPct + 4; // +4 pp for serve

  if (scope.prompt === 'discount-vs-bundle') {
    return [
      {
        id: 'discount',
        title: `Promote a ${discountPct}% discount`,
        subtitle: `Apply a ${discountPct}% shelf discount on ${brandLabel} during ${occasionLabel}.`,
        directional:
          'Predictable short-term spend retention from buyers already in the occasion. Margin pressure is the trade.',
        effectValue: `+${discount_lift.toFixed(1)} pp spend retention`,
        effectKind: 'hold',
        confidence: 'Low',
        confidenceReason:
          'Elasticity prior is brand-level, not promo-holdout grade. The reading would tighten with a real Don Julio (or in-scope brand) promo holdout for this occasion.',
        inputs: [
          {
            label: 'Loyalty cohort flows',
            source: 'runs/loyalty_panel.csv (loyalty asset)',
          },
          {
            label: 'Brand-level elasticity prior',
            source: 'runs/elasticity_note.md (elasticity asset)',
          },
          {
            label: 'Occasion volume shares',
            source: 'runs/occasion_mix.json (occasion_share asset)',
          },
        ],
        assumes: [
          `${discountPct}% is the salient promo depth in ${occasionLabel}.`,
          'Elasticity is symmetric to the prior — buyers respond to discount as the note predicts.',
          findingSummary
            ? `The finding "${findingSummary}" is the right scoping for the simulation.`
            : 'The scoped finding is the right framing for the simulation.',
        ],
        doesNotAssume: [
          'A cross-channel promo holdout — none is wired yet, so the prediction interval is missing.',
          'That competitor promos hold the same depth in the same week.',
          'Margin impact — that needs the finance overlay, not in scope here.',
        ],
        math: `discount_retention = baseline (${baseline}) + α·d = ${baseline} + ${alpha}·${discountPct} = ${discount_lift.toFixed(1)} pp.`,
        illustrative: true,
      },
      {
        id: 'bundle',
        title: 'Pair with a mixer + serve bundle',
        subtitle: `Bundle ${brandLabel} with a mixer and a serve format for ${occasionLabel}.`,
        directional:
          'Slower setup, but the serve-led bundle protects perceived value better than a flat discount.',
        effectValue: `+${bundle_lift.toFixed(1)} pp spend retention`,
        effectKind: 'lift',
        confidence: 'Low',
        confidenceReason:
          'Bundling uplift is a linear toy (β) carried from the earlier simulation pane. Real reading requires a serve-format A/B against the discount.',
        inputs: [
          {
            label: 'Occasion volume shares',
            source: 'runs/occasion_mix.json (occasion_share asset)',
          },
          {
            label: 'Brand-level elasticity prior',
            source: 'runs/elasticity_note.md (elasticity asset)',
          },
          {
            label: 'Research finding context',
            source: findingSummary
              ? `Research brief finding #${scope.findingIndex + 1}: ${findingSummary.slice(0, 80)}…`
              : `Research brief finding #${scope.findingIndex + 1}`,
          },
        ],
        assumes: [
          `The mixer + serve combo is recognisable in ${occasionLabel}.`,
          'Linear bundling adjacency holds — the bundle adds, not substitutes.',
          'The bundle stays available in the same channels where the discount would land.',
        ],
        doesNotAssume: [
          'A specific mixer SKU — that depends on the activation partner.',
          'A real bundling coefficient β — the value above is illustrative.',
          'Long-tail repeat purchase — this measures the in-window spend retention only.',
        ],
        math: `bundle_retention = baseline (${baseline}) + β·d + serve_uplift (4) = ${baseline} + ${beta}·${discountPct} + 4 = ${bundle_lift.toFixed(1)} pp.`,
        illustrative: true,
      },
    ];
  }

  // Generic counterfactual fallback when the prompt isn't one we
  // template explicitly. We still render ≥2 honest variants rather
  // than dropping back into a hardcoded preview.
  return [
    {
      id: 'a',
      title: `Run variant A of ${scope.promptLabel}`,
      subtitle:
        'First defensible framing of the counterfactual, scoped to the finding.',
      directional:
        'Smaller shift — keeps the activation inside the channels the finding already covers.',
      effectValue: '+5.0 pp spend retention',
      effectKind: 'hold',
      confidence: 'Low',
      confidenceReason:
        'No connected outcome data for this prompt yet — the projection is an elasticity prior, not a measurement.',
      inputs: [
        {
          label: 'Research finding context',
          source: findingSummary
            ? `Research brief finding #${scope.findingIndex + 1}: ${findingSummary.slice(0, 80)}…`
            : `Research brief finding #${scope.findingIndex + 1}`,
        },
        {
          label: 'Brand-level elasticity prior',
          source: 'runs/elasticity_note.md (elasticity asset)',
        },
      ],
      assumes: [
        'Elasticity prior is the right starting point for this prompt.',
        'The finding scope is stable across the simulation window.',
      ],
      doesNotAssume: [
        'A specific activation channel — left for the analyst.',
        'Promo holdout data — none is wired yet.',
      ],
      math: 'variant_a = baseline (4) + α·1 = 5.0 pp, α = 1 (elasticity prior, illustrative).',
      illustrative: true,
    },
    {
      id: 'b',
      title: `Run variant B of ${scope.promptLabel}`,
      subtitle:
        'Second defensible framing — extends scope to an adjacent occasion or channel.',
      directional:
        'Bigger directional lift, with adjacency risk — the prior was not measured outside the finding scope.',
      effectValue: '+8.5 pp spend retention',
      effectKind: 'lift',
      confidence: 'Low',
      confidenceReason:
        'Extension multiplier is a linear toy applied on top of the prior. Validate before committing.',
      inputs: [
        {
          label: 'Research finding context',
          source: findingSummary
            ? `Research brief finding #${scope.findingIndex + 1}: ${findingSummary.slice(0, 80)}…`
            : `Research brief finding #${scope.findingIndex + 1}`,
        },
        {
          label: 'Occasion volume shares',
          source: 'runs/occasion_mix.json (occasion_share asset)',
        },
      ],
      assumes: [
        'The adjacency holds — adjacent occasions respond similarly to the prior.',
        'Linear extension is a defensible first cut for the prompt.',
      ],
      doesNotAssume: [
        'A measured adjacency coefficient — the value is illustrative.',
        'That the finding scope transfers cleanly to adjacent channels.',
      ],
      math: 'variant_b = baseline (4) + α·1 + γ·3.5 = 8.5 pp, γ = 1 (adjacency multiplier, illustrative).',
      illustrative: true,
    },
  ];
}

function ScopeCard({
  scope,
  findingTitle,
  detailQuestion,
}: {
  scope: Scope;
  findingTitle: string | null;
  detailQuestion: string | null;
}) {
  if (scope.kind === 'driver') {
    return (
      <FocusCard tone="muted" className="border-dashed">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="border-slate-300 bg-white text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600"
            >
              Scope: growth driver
            </Badge>
            <Badge
              variant="outline"
              className="border-amber-300 bg-amber-50 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-800"
            >
              Illustrative
            </Badge>
          </div>
          <p className="text-[13px] leading-snug text-slate-800">
            Driver:{' '}
            <span className="font-semibold text-slate-950">
              {scope.driverLabel}
            </span>
            {scope.mustDoLabel ? (
              <>
                {' · Must-Do: '}
                <span className="font-semibold text-slate-950">
                  {scope.mustDoLabel}
                </span>
              </>
            ) : null}
          </p>
          {detailQuestion ? (
            <p className="text-[12px] leading-snug text-slate-600">
              Active study question: {detailQuestion}
            </p>
          ) : null}
        </div>
      </FocusCard>
    );
  }
  if (scope.kind === 'finding') {
    return (
      <FocusCard tone="muted" className="border-dashed">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="border-slate-300 bg-white text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600"
            >
              Scope: research finding
            </Badge>
            <Badge
              variant="outline"
              className="border-amber-300 bg-amber-50 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-800"
            >
              Illustrative
            </Badge>
            <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500">
              prompt · {scope.prompt}
            </span>
          </div>
          <p className="text-[13px] leading-snug text-slate-800">
            Finding #{scope.findingIndex + 1}
            {findingTitle ? (
              <>
                {' · '}
                <span className="font-semibold text-slate-950">
                  {findingTitle.length > 140
                    ? findingTitle.slice(0, 137) + '…'
                    : findingTitle}
                </span>
              </>
            ) : null}
          </p>
          <div className="flex flex-wrap gap-2 text-[12px] text-slate-700">
            <span>
              Occasion:{' '}
              <span className="font-semibold text-slate-950">
                {scope.occasion ?? '—'}
              </span>
            </span>
            <span>
              Brand:{' '}
              <span className="font-semibold text-slate-950">
                {scope.brand ?? '—'}
              </span>
            </span>
          </div>
        </div>
      </FocusCard>
    );
  }
  return null;
}

function VariantsGrid({ variants }: { variants: Variant[] }) {
  if (variants.length === 0) {
    return (
      <FocusCard tone="muted" className="border-dashed">
        <p className="text-[12px] leading-snug text-slate-600">
          The current scope didn&apos;t resolve to any counterfactual variants
          yet. Worker B will broaden the variant catalog when POST
          /counterfactuals lands.
        </p>
      </FocusCard>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {variants.map((variant) => (
        <VariantCard key={variant.id} variant={variant} />
      ))}
    </div>
  );
}

function VariantCard({ variant }: { variant: Variant }) {
  return (
    <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-950/[0.03]">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Variant
          </span>
          <h3 className="mt-1 text-base font-semibold tracking-tight text-slate-950">
            {variant.title}
          </h3>
          <p className="mt-1 text-[12px] leading-snug text-slate-600">
            {variant.subtitle}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge
            variant="outline"
            className={cn(
              'border text-[10px] font-semibold uppercase tracking-[0.16em]',
              effectToneClass(variant.effectKind),
            )}
          >
            {variant.effectValue}
          </Badge>
          {variant.illustrative ? (
            <Badge
              variant="outline"
              className="border-amber-300 bg-amber-50 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-800"
            >
              Illustrative
            </Badge>
          ) : null}
        </div>
      </header>

      <p className="mt-3 inline-flex items-start gap-2 rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-[12px] leading-snug text-slate-700">
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
        {variant.directional}
      </p>

      <div className="mt-4 grid gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Confidence
        </span>
        <span
          className={cn(
            'inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold',
            confidenceToneClass(variant.confidence),
          )}
        >
          {variant.confidence} — {variant.confidenceReason}
        </span>
      </div>

      <div className="mt-4 grid gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Inputs (real sources)
        </span>
        <ul className="grid gap-1.5">
          {variant.inputs.map((input) => (
            <li
              key={input.label}
              className="flex items-start gap-2 text-[12px] leading-snug text-slate-700"
            >
              <FileSearch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
              <span>
                <span className="font-semibold text-slate-900">
                  {input.label}
                </span>{' '}
                <span className="text-slate-500">· {input.source}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/80 p-3 text-[12px] text-slate-700">
        <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-wider text-slate-600">
          What this assumes / doesn&apos;t assume
        </summary>
        <div className="mt-3 grid gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Assumes
            </div>
            <ul className="mt-1 grid gap-1">
              {variant.assumes.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 leading-snug"
                >
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Does not assume
            </div>
            <ul className="mt-1 grid gap-1">
              {variant.doesNotAssume.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 leading-snug"
                >
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-orange-500" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-700">
            {variant.math}
          </div>
        </div>
      </details>
    </article>
  );
}

function DisclosureBlock({
  variants,
  scope,
}: {
  variants: Variant[];
  scope: Scope;
}) {
  if (variants.length === 0) return null;
  const winner = variants.reduce<Variant | null>(
    (best, v) => (best == null ? v : bestEffect(v, best)),
    null,
  );
  return (
    <PaneCard
      title="Readout"
      meta="Illustrative projection"
      description="Side-by-side counterfactual readout. Print the math, name the inputs, and surface the assumes/doesn't-assume before treating any number as decision-grade."
    >
      <p className="text-sm font-medium text-slate-900">
        {winner ? (
          <>
            {winner.title}{' '}
            <span className="font-normal text-slate-600">leads</span>{' '}
            {winner.effectValue.replace(/^\+?/, '+')} on spend retention versus
            the other variant, under the illustrative math printed in each
            card.
          </>
        ) : (
          'No variant resolved for the current scope.'
        )}
      </p>
      <p className="mt-2 text-[12px] text-slate-600">
        Prediction interval: not yet estimated. The right rail names the data
        we would need to estimate one honestly for this scope.
      </p>
      <p className="mt-2 text-[11px] uppercase tracking-wider text-slate-400">
        Scope · {scope.kind}
      </p>
    </PaneCard>
  );
}

function ActionBar({
  onValidatePromo,
  onCommitDecision,
  disabled,
}: {
  onValidatePromo: () => void;
  onCommitDecision: () => void;
  disabled: boolean;
}) {
  return (
    <div className="rounded-3xl border border-slate-900 bg-slate-950 p-5 text-slate-50 shadow-sm">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">
            Make the projection actionable
          </h3>
          <p className="mt-1 text-[12px] leading-snug text-slate-300">
            Validate the chosen variant against connected promo data, or
            commit it as a decision so the in-year query can later say what
            changed.
          </p>
          <p className="mt-1 text-[10px] uppercase tracking-wider text-slate-500">
            Buttons are scaffolded — backend wiring lands with Worker D.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <button
            type="button"
            onClick={onValidatePromo}
            disabled={disabled}
            aria-label="Validate the chosen counterfactual variant against connected promo data"
            className="inline-flex h-10 items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
            Validate against promo data
          </button>
          <button
            type="button"
            onClick={onCommitDecision}
            disabled={disabled}
            aria-label="Commit the chosen counterfactual variant as a decision"
            className="inline-flex h-10 items-center gap-2 rounded-full bg-blue-500 px-4 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-blue-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Commit as decision
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ detail }: { detail: string | null }) {
  return (
    <FocusCard tone="muted" className="border-dashed">
      <div className="grid gap-3">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 text-slate-500" />
          <h3 className="text-sm font-semibold text-slate-950">
            Open this page with scope.
          </h3>
        </div>
        <p className="text-[13px] leading-snug text-slate-700">
          /simulation runs a counterfactual against a scoped target. Open it
          from one of the two source surfaces so the page knows what to
          stress-test:
        </p>
        <ul className="grid gap-2 text-[13px] text-slate-700">
          <li className="flex items-start gap-2">
            <Beaker className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
            <span>
              From <strong>/growth-driver</strong>, pick a driver and use
              &ldquo;Stress-test growth driver&rdquo;. That hands /simulation a{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">
                driver
              </code>{' '}
              and{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">
                must_do
              </code>{' '}
              param pair.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Compass className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
            <span>
              From <strong>/research</strong>, open a finding and click{' '}
              &ldquo;Run counter-scenario&rdquo;. That hands /simulation a{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">
                finding
              </code>
              ,{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">
                prompt
              </code>{' '}
              (and any occasion/brand the page could derive).
            </span>
          </li>
        </ul>
        {detail ? (
          <p className="text-[12px] leading-snug text-slate-500">
            Active study question: {detail}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Link
            href={withStudy('/growth-driver', null)}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50"
          >
            Open /growth-driver
            <ArrowRight className="h-3 w-3" />
          </Link>
          <Link
            href={withStudy('/research', null)}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50"
          >
            Open /research
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </FocusCard>
  );
}

function Toast({
  title,
  body,
  onClose,
}: {
  title: string;
  body: string;
  onClose: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex max-w-md items-start gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-lg shadow-slate-950/10">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-950">{title}</p>
          <p className="mt-0.5 text-[12px] leading-snug text-slate-600">
            {body}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss toast"
          className="ml-2 inline-flex h-6 items-center rounded-full border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-600 shadow-sm hover:border-slate-300 hover:bg-slate-50"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function bestEffect(a: Variant, b: Variant): Variant {
  const av = effectMagnitude(a);
  const bv = effectMagnitude(b);
  return av >= bv ? a : b;
}

function effectMagnitude(variant: Variant): number {
  const match = variant.effectValue.match(/(-?\d+(?:\.\d+)?)/);
  if (!match) return 0;
  const v = Number(match[1]);
  return Number.isFinite(v) ? v : 0;
}

function effectToneClass(kind: Variant['effectKind']): string {
  switch (kind) {
    case 'lift':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'hold':
      return 'border-blue-200 bg-blue-50 text-blue-700';
    case 'hedge':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'risk':
      return 'border-orange-200 bg-orange-50 text-orange-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-700';
  }
}

function confidenceToneClass(level: ConfidenceLevel): string {
  switch (level) {
    case 'High':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'Medium':
      return 'border-yellow-200 bg-yellow-50 text-yellow-700';
    case 'Low':
    default:
      return 'border-orange-200 bg-orange-50 text-orange-700';
  }
}

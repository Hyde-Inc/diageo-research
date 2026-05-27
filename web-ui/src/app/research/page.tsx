'use client';

/**
 * /research — the Findings page.
 *
 * Desktop layout (≥1280px):
 *   ┌──────────────┬─────────────────────────┬─────────────────┐
 *   │ Findings rail│ Selected finding detail │ "What's next"   │
 *   │ (sticky,     │ (what's happening, why  │ action rail     │
 *   │  scrollable) │ it matters, evidence,   │ (Stress-test,   │
 *   │              │ see-evidence CTA)       │ Take to MBP, …) │
 *   └──────────────┴─────────────────────────┴─────────────────┘
 *
 * Mobile/narrow: same three sections, stacked. Findings rail is
 * height-capped so it never dominates the page.
 *
 * The H1 is the full study question, wrapped, never truncated. The
 * "Top findings" / "Top risks" section title adapts to the question's
 * framing. Selection state lives in `?finding=<idx>` so links are
 * deep-linkable.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Beaker,
  Compass,
  HelpCircle,
  ListPlus,
  MessageCircle,
  PencilLine,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ConfidencePanel } from '@/components/study/confidence-panel';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  wb,
  type ResearchSummary,
  type SpecCurveRow,
  type TopRiskCard,
} from '@/components/workbench/types';

type Finding = {
  id: string;
  rank: number;
  clusterId: number;
  title: string;
  whatsHappening: string;
  whyItMatters: string;
  evidence: string[];
  illustrative: boolean;
  robustness: number;
  nAgree: number;
  nTotal: number;
  fragileSpecs: string[];
  /** Occasion this finding is scoped to, when one is on the matched
   * top-risk card — drives downstream /simulation occasion= param. */
  occasion?: string | null;
};

export default function ResearchPage() {
  const data = useStudyData();
  const { studyId, loadingDetail, curve, prereg, detail, loadingCurve } = data;
  const router = useRouter();
  const searchParams = useSearchParams();
  const findingParam = searchParams.get('finding');

  const [researchFetch, setResearchFetch] = useState<{
    key: string;
    value: ResearchSummary | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!studyId) return;
    let cancelled = false;
    const key = studyId;
    wb.research(studyId)
      .then((s) => {
        if (!cancelled) setResearchFetch({ key, value: s, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setResearchFetch({
            key,
            value: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  const summary =
    studyId && researchFetch?.key === studyId ? researchFetch.value : null;
  const researchError =
    studyId && researchFetch?.key === studyId ? researchFetch.error : null;
  const loading = loadingDetail || loadingCurve;

  const question = detail?.question?.trim() || summary?.question?.trim() || '';

  const findings = useMemo<Finding[]>(
    () => buildFindings(curve?.rows ?? [], summary?.top_risks ?? []),
    [curve, summary],
  );

  const selectedIndex = useMemo(() => {
    if (findings.length === 0) return -1;
    const parsed = findingParam == null ? 0 : Number(findingParam);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed < findings.length) {
      return parsed;
    }
    return 0;
  }, [findingParam, findings.length]);

  const selectFinding = (idx: number) => {
    const params = new URLSearchParams(searchParams.toString());
    if (idx <= 0) params.delete('finding');
    else params.set('finding', String(idx));
    const qs = params.toString();
    router.replace(qs ? `/research?${qs}` : '/research');
  };

  const selected = findings[selectedIndex] ?? null;

  return (
    <StudyShell
      data={data}
      eyebrow="Research"
      title={question || 'No study question registered yet'}
      contentClassName="max-w-[1500px]"
      leftLabel="Findings list"
      mainLabel="Selected finding detail"
      rightLabel="Next actions"
      left={
        !studyId ? null : loading ? (
          <RailSkeleton />
        ) : findings.length === 0 ? null : (
          <FindingsRail
            findings={findings}
            selectedIndex={selectedIndex}
            onSelect={selectFinding}
            illustrative={Boolean(summary?.brief_illustrative)}
          />
        )
      }
      main={
        !studyId ? null : loading ? (
          <FocusCard tone="muted">
            <div className="h-48 animate-pulse rounded-2xl bg-slate-200/70" />
          </FocusCard>
        ) : findings.length === 0 ? (
          <FocusCard>
            <p className="text-sm text-slate-600">
              {researchError
                ? researchError
                : 'No findings have crystallised yet — either the briefs are still being written or no scenario produced a directive sentence.'}{' '}
              Check{' '}
              <Link
                href={withStudy('/setup', studyId)}
                className="font-medium text-slate-900 underline-offset-4 hover:underline"
              >
                Setup
              </Link>{' '}
              for run status.
            </p>
          </FocusCard>
        ) : (
          <div className="grid gap-4">
            {selected ? <FindingDetail finding={selected} studyId={studyId} /> : null}
            <ConfidencePanel
              curve={curve}
              prereg={prereg}
              interval={{
                kind: 'confidence interval',
                available: false,
                requiredData:
                  'connected outcome observations or a reserved holdout for the agreed research question.',
              }}
              provenance={{
                source:
                  'Research findings, scenario clustering, and clicked evidence traces',
                transformation:
                  'Pre-registered rubric plus scenario clustering',
                output:
                  'Ranked findings with explicit holds-in-N-of-M counts',
                available: Boolean(summary?.brief_markdown),
              }}
              raiseConfidence={[
                'Estimate the confidence interval from observed outcome or holdout data.',
                'Confirm the pre-registered decision rule with stakeholders before reading the findings.',
                'Run the same question across the exposed audience and timing cuts.',
              ]}
            />
          </div>
        )
      }
      right={
        !studyId ? null : (
          <ActionRail
            studyId={studyId}
            hasFindings={findings.length > 0}
            selectedFinding={selected}
            selectedIndex={selectedIndex}
            counterScenarioParams={buildCounterScenarioParams(
              selected,
              selectedIndex,
              question,
            )}
          />
        )
      }
    />
  );
}

function FindingsRail({
  findings,
  selectedIndex,
  onSelect,
  illustrative,
}: {
  findings: Finding[];
  selectedIndex: number;
  onSelect: (idx: number) => void;
  illustrative: boolean;
}) {
  const sectionTitle = 'Findings, ranked by agreement.';
  const dimmed = findings.length <= 1;
  return (
    <FocusCard>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            {sectionTitle}
          </h2>
        </div>
        {illustrative ? (
          <Badge
            variant="outline"
            className="border-amber-200 bg-amber-50 text-[9px] uppercase tracking-wide text-amber-800"
          >
            Illustrative
          </Badge>
        ) : null}
      </header>
      <ul
        className={cn(
          'mt-3 max-h-80 overflow-y-auto pr-1 xl:max-h-none',
          dimmed && 'opacity-70',
        )}
        aria-label={sectionTitle}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const dir = e.key === 'ArrowDown' ? 1 : -1;
            const next = (selectedIndex + dir + findings.length) % findings.length;
            onSelect(next);
          }
        }}
      >
        {findings.map((f, idx) => {
          const active = idx === selectedIndex;
          return (
            <li key={f.id} className="mb-1.5 last:mb-0">
              <button
                type="button"
                onClick={() => onSelect(idx)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'group grid w-full gap-1 rounded-xl border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
                  active
                    ? 'border-slate-900 bg-slate-950 text-white shadow-sm'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span
                    className={cn(
                      'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold tabular-nums',
                      active
                        ? 'bg-white/15 text-white'
                        : 'bg-slate-100 text-slate-600',
                    )}
                  >
                    {f.rank}
                  </span>
                  <span className="line-clamp-2 flex-1 text-[12px] font-semibold leading-snug">
                    {f.title}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <ConfidenceChip
                    holds={f.nAgree}
                    total={f.nTotal}
                    robustness={f.robustness}
                    onDark={active}
                  />
                </div>
                <SourceLabelsLine
                  labels={f.evidence}
                  onDark={active}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </FocusCard>
  );
}

function FindingDetail({
  finding,
  studyId,
}: {
  finding: Finding;
  studyId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const longBody =
    finding.whatsHappening.length + finding.whyItMatters.length > 360;
  const happening =
    longBody && !expanded
      ? trimToBoundary(finding.whatsHappening, 220)
      : finding.whatsHappening;
  const matters =
    longBody && !expanded
      ? trimToBoundary(finding.whyItMatters, 220)
      : finding.whyItMatters;
  return (
    <FocusCard>
      <div className="grid gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-bold tabular-nums text-slate-600">
              {finding.rank}
            </span>
            <h3 className="text-balance text-base font-semibold tracking-tight text-slate-950">
              {finding.title}
            </h3>
          </div>
          {finding.illustrative ? (
            <Badge
              variant="outline"
              className="border-amber-200 bg-amber-50 text-[9px] uppercase tracking-wide text-amber-800"
            >
              Illustrative
            </Badge>
          ) : null}
        </div>
        <ConfidenceLine finding={finding} />
        <dl className="grid gap-2 text-[13px] leading-snug">
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              What&apos;s happening
            </dt>
            <dd className="mt-0.5 text-slate-800">{happening}</dd>
          </div>
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Why it matters
            </dt>
            <dd className="mt-0.5 text-slate-800">{matters}</dd>
          </div>
        </dl>
        {longBody ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-fit text-[11px] font-medium text-slate-700 underline-offset-2 hover:underline"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        ) : null}
        {finding.evidence.length > 0 ? (
          <div className="grid gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              What supports it
            </span>
            <ul className="flex flex-wrap gap-1">
              {finding.evidence.map((label) => (
                <li
                  key={label}
                  className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-700"
                >
                  {label}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {studyId ? (
            <Link
              href={withStudy('/evidence', studyId)}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-slate-950 px-3.5 text-[12px] font-semibold text-white shadow-sm hover:bg-slate-800"
            >
              See evidence
              <ArrowRight className="h-3 w-3" />
            </Link>
          ) : null}
          {studyId ? (
            <Link
              href={withStudy(`/scenario/${finding.clusterId}`, studyId)}
              className="inline-flex h-9 items-center gap-1 rounded-full border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50"
            >
              Open scenario
            </Link>
          ) : null}
        </div>
      </div>
    </FocusCard>
  );
}

function ActionRail({
  studyId,
  hasFindings,
  selectedFinding,
  selectedIndex,
  counterScenarioParams,
}: {
  studyId: string | null;
  hasFindings: boolean;
  selectedFinding: Finding | null;
  selectedIndex: number;
  counterScenarioParams: Record<string, string>;
}) {
  if (!studyId) return null;
  const findingScope: Record<string, string> | undefined =
    selectedFinding != null
      ? { finding: String(selectedIndex >= 0 ? selectedIndex : 0) }
      : undefined;
  const clusterScope: Record<string, string> | undefined =
    selectedFinding != null
      ? { cluster: String(selectedFinding.clusterId) }
      : undefined;
  return (
    <FocusCard>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        What&apos;s next
      </h3>
      {selectedFinding ? (
        <p className="mt-1 text-[11px] leading-snug text-slate-600">
          Acting on:{' '}
          <em className="font-semibold not-italic text-slate-900">
            {selectedFinding.title}
          </em>
        </p>
      ) : null}
      <div className="mt-3 grid gap-2">
        <ActionPrimary
          href={withStudy('/growth-driver', studyId, findingScope)}
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          label="Take to MBP"
          detail="Move this finding into the growth-driver planner."
        />
        <ActionSecondary
          href={withStudy('/robustness', studyId, clusterScope)}
          icon={<Compass className="h-3.5 w-3.5" />}
          label="Stress-test"
          detail="See which framings hold, weaken, or flip this finding."
        />
        <ActionSecondary
          href={withStudy('/simulation', studyId, counterScenarioParams)}
          icon={<Beaker className="h-3.5 w-3.5" />}
          label="Run counter-scenario"
          detail="Open /simulation scoped to this finding to test a counterfactual."
        />
        <ActionSecondary
          href={withStudy('/plan', studyId)}
          icon={<PencilLine className="h-3.5 w-3.5" />}
          label="Refine the question"
          detail="Edit the plan in plain English and re-run one scenario."
        />
        <ActionSecondary
          href={withStudy('/plan', studyId, {
            prefill:
              'Add a new dimension to explore (for example, add a price-tier dimension with premium and value values) so we get more defensible framings.',
          })}
          icon={<ListPlus className="h-3.5 w-3.5" />}
          label="Add scenarios"
          detail="Add a dimension to explore more defensible framings."
        />
        <ActionSecondary
          href={withStudy('/ask', studyId)}
          icon={<MessageCircle className="h-3.5 w-3.5" />}
          label="Ask a follow-up"
          detail="Scoped to this study's findings, briefs, and evidence."
        />
        <ActionSecondary
          href={withStudy('/evidence', studyId)}
          icon={<HelpCircle className="h-3.5 w-3.5" />}
          label="See all evidence"
          detail="Browse every grounded claim behind the findings."
        />
      </div>
      {!hasFindings ? (
        <p className="mt-3 inline-flex items-start gap-1.5 text-[11px] leading-snug text-slate-500">
          <Sparkles className="mt-0.5 h-3 w-3 text-slate-400" />
          Some actions become more useful once the first scenarios finish.
        </p>
      ) : null}
    </FocusCard>
  );
}

function ActionPrimary({
  href,
  icon,
  label,
  detail,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  detail: string;
}) {
  return (
    <Link
      href={href}
      className="group grid gap-1 rounded-2xl border border-slate-900 bg-slate-950 p-3 text-white shadow-sm transition-colors hover:bg-slate-800"
    >
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold">
        {icon}
        {label}
        <ArrowRight className="ml-auto h-3.5 w-3.5 text-slate-300 transition-transform group-hover:translate-x-0.5" />
      </span>
      <span className="text-[11px] leading-snug text-slate-300">{detail}</span>
    </Link>
  );
}

function ActionSecondary({
  href,
  icon,
  label,
  detail,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  detail: string;
}) {
  return (
    <Link
      href={href}
      className="group grid gap-1 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
    >
      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-slate-900">
        {icon}
        {label}
        <ArrowRight className="ml-auto h-3 w-3 text-slate-400 transition-transform group-hover:translate-x-0.5" />
      </span>
      <span className="text-[11px] leading-snug text-slate-600">{detail}</span>
    </Link>
  );
}

function RailSkeleton() {
  return (
    <FocusCard tone="muted">
      <div className="grid gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-xl bg-slate-200/70"
          />
        ))}
      </div>
    </FocusCard>
  );
}

function ConfidenceChip({
  holds,
  total,
  robustness,
  onDark,
}: {
  holds: number;
  total: number;
  robustness: number;
  onDark: boolean;
}) {
  const baseTone =
    robustness >= 0.7
      ? onDark
        ? 'bg-emerald-500/20 text-emerald-100'
        : 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : robustness >= 0.4
        ? onDark
          ? 'bg-yellow-500/20 text-yellow-100'
          : 'border-yellow-200 bg-yellow-50 text-yellow-700'
        : onDark
          ? 'bg-orange-500/20 text-orange-100'
          : 'border-orange-200 bg-orange-50 text-orange-700';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0 text-[10px] font-semibold tabular-nums',
        onDark ? '' : 'border',
        baseTone,
      )}
    >
      Holds in {holds} of {total}
    </span>
  );
}

function ConfidenceLine({ finding }: { finding: Finding }) {
  const tone =
    finding.robustness >= 0.7
      ? {
          pill: 'border-emerald-200 bg-emerald-50 text-emerald-700',
          bar: 'bg-emerald-500',
        }
      : finding.robustness >= 0.4
        ? {
            pill: 'border-yellow-200 bg-yellow-50 text-yellow-700',
            bar: 'bg-yellow-500',
          }
        : {
            pill: 'border-orange-200 bg-orange-50 text-orange-700',
            bar: 'bg-orange-500',
          };
  const total = finding.nTotal;
  const holds = finding.nAgree;
  const phrasing =
    total === 0
      ? 'Confidence not yet computed — scenarios are still running'
      : total === 1
        ? holds >= 1
          ? 'Holds in 1 of 1 scenario'
          : 'Does not hold in this single scenario'
        : `Holds in ${holds} of ${total} scenarios`;
  const fragilePreview =
    finding.fragileSpecs.length > 0
      ? `; flips on ${finding.fragileSpecs.slice(0, 2).join(', ')}${
          finding.fragileSpecs.length > 2 ? '…' : ''
        }`
      : '';
  return (
    <div className="grid gap-1">
      <span
        className={cn(
          'inline-flex w-fit items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold',
          tone.pill,
        )}
      >
        {phrasing}
        {fragilePreview ? (
          <span className="ml-1 font-medium text-slate-600">
            {fragilePreview}
          </span>
        ) : null}
      </span>
      {total > 0 ? (
        <div className="h-1 w-48 max-w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={cn('h-full', tone.bar)}
            style={{ width: `${Math.round(finding.robustness * 100)}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function SourceLabelsLine({
  labels,
  onDark,
}: {
  labels: string[];
  onDark: boolean;
}) {
  const visible = labels.slice(0, 2);
  const overflow = labels.length - visible.length;
  const text =
    labels.length === 0
      ? 'no linked sources'
      : `Backed by: ${visible.join(' · ')}${overflow > 0 ? ` · +${overflow} more` : ''}`;
  return (
    <span
      className={cn(
        'block truncate text-[10px] leading-snug',
        onDark ? 'text-slate-300' : 'text-slate-500',
      )}
      title={labels.length > visible.length ? labels.join(' · ') : undefined}
    >
      {text}
    </span>
  );
}

// Build the param bag for the "Run counter-scenario" CTA. The plan
// (FR-RS-1) calls for prompt=discount-vs-bundle on occasion-exposure
// findings by default, plus a derived occasion and brand when they can
// be read from the finding text or study question. Anything we can't
// derive is left off so /simulation renders its honest empty state
// instead of fabricating a default.
function buildCounterScenarioParams(
  finding: Finding | null,
  selectedIndex: number,
  question: string,
): Record<string, string> {
  const params: Record<string, string> = {
    finding: String(selectedIndex >= 0 ? selectedIndex : 0),
    prompt: 'discount-vs-bundle',
  };
  if (!finding) return params;
  const occasion = finding.occasion?.trim();
  if (occasion) params.occasion = occasion;
  const brand = deriveBrand(
    finding.title,
    finding.whatsHappening,
    finding.whyItMatters,
    question,
  );
  if (brand) params.brand = brand;
  return params;
}

function buildFindings(
  rows: SpecCurveRow[],
  topRisks: TopRiskCard[],
): Finding[] {
  const risksByKey = new Map<string, TopRiskCard>();
  for (const r of topRisks) {
    const key = (r.line || '').slice(0, 40).toLowerCase().trim();
    if (key) risksByKey.set(key, r);
  }

  return rows.map((row, idx) => {
    const total = row.n_agree + row.n_weaker + row.n_flips + row.n_missing;
    const text = cleanRepresentative(row.representative);
    const sentences = splitSentences(text);
    const happening = sentences[0] ?? text;
    const followUp = sentences.slice(1, 3).filter((s) => s.length < 240);
    const mattersBecause =
      followUp.join(' ').trim() ||
      `Holds in ${row.n_agree} of ${total} defensible framings — strong enough that breaking it would move the headline answer.`;
    const title = titleFromSentence(happening);

    const repKey = text.slice(0, 40).toLowerCase().trim();
    let matchedRisk: TopRiskCard | undefined;
    if (repKey) matchedRisk = risksByKey.get(repKey);
    if (!matchedRisk && topRisks.length > 0 && idx < topRisks.length) {
      matchedRisk = topRisks[idx];
    }
    const evidence = humaniseSupports(matchedRisk?.source_assets ?? []);
    return {
      id: String(row.cluster_id),
      rank: idx + 1,
      clusterId: row.cluster_id,
      title,
      whatsHappening: happening,
      whyItMatters: mattersBecause,
      evidence,
      illustrative: Boolean(matchedRisk?.illustrative),
      robustness: row.robustness,
      nAgree: row.n_agree,
      nTotal: total,
      fragileSpecs: humaniseFragile(row.fragile_specs),
      occasion: matchedRisk?.occasion ?? null,
    };
  });
}

// Known Diageo NA brands the demo studies discuss. Used to derive a
// brand= param for /simulation when neither the finding nor the matched
// risk card spell one out. If nothing matches we leave brand off so the
// downstream page can render its honest empty state.
const KNOWN_BRANDS = [
  'Don Julio',
  'Crown Royal',
  'Tanqueray',
  'Guinness',
  'Smirnoff',
  'Captain Morgan',
  'Johnnie Walker',
  'Bulleit',
  'Casamigos',
  'Ketel One',
  'Buchanan’s',
  'Buchanans',
  'Baileys',
  'Cîroc',
  'Ciroc',
];

function deriveBrand(...sources: Array<string | null | undefined>): string | null {
  const blob = sources.filter(Boolean).join(' ');
  if (!blob) return null;
  for (const brand of KNOWN_BRANDS) {
    const pattern = new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i');
    if (pattern.test(blob)) {
      return brand.replace('Buchanans', 'Buchanan’s').replace('Ciroc', 'Cîroc');
    }
  }
  return null;
}

function cleanRepresentative(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  // Cut off where the brief slips into its pre-registration / decision
  // rule section — that copy belongs on the Setup page, not in a
  // finding card.
  const cutMatch = trimmed.search(/##\s*Pre-?registration|##\s+/i);
  const sliced = cutMatch >= 0 ? trimmed.slice(0, cutMatch) : trimmed;
  return sliced
    .replace(/\*\*/g, '')
    .replace(/_+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(text: string): string[] {
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function titleFromSentence(first: string): string {
  const trimmed = first.trim();
  if (!trimmed) return 'Finding';
  const candidate = trimmed.split(/[,;:]\s+/)[0];
  const cleaned = candidate.replace(/[.!?]+$/, '').trim();
  if (cleaned.length === 0) return trimmed.slice(0, 80);
  if (cleaned.length > 90) return trimmed.slice(0, 80) + '…';
  return cleaned;
}

function humaniseFragile(specs: string[]): string[] {
  return specs
    .slice(0, 4)
    .map((s) => s.replace(/__/g, ' / ').replace(/_/g, ' '));
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
    const label = SUPPORT_LABELS[key] ?? toTitleCase(stem) ?? 'Research evidence';
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out.slice(0, 3);
}

function trimToBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 40 ? slice.slice(0, lastSpace) : slice) + '…';
}

function toTitleCase(value: string): string {
  if (!value) return '';
  return value
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

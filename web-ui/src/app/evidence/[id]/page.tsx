'use client';

/**
 * /evidence/[id] — verify one claim, end-to-end.
 *
 * Replaces the previous "linear claim → source → transformation →
 * output" walk that printed "lens·solo" dimension badges and a generic
 * "100% robust" chip. The redesigned page reads like:
 *
 *   Verify panel        — three plain-language checks (rubric,
 *                          provenance, robustness) mirroring the
 *                          /answer ConfidencePanel.
 *   Step 1 Claim        — the actual sentence(s) from the final brief,
 *                          with a "see full paragraph" toggle when the
 *                          paragraph is long.
 *   Step 2 Sources      — clickable source cards built from final.json
 *                          citations (BLS, BEA, DISCUS, SQL queries,
 *                          …) with the [Sx] citations that appear in
 *                          the claim's paragraph highlighted first.
 *   Step 3 Transformation — pipeline steps in plain language, with a
 *                            disclosure for raw timings/cost.
 *   Step 4 Robustness     — sentence + small bar viz + "Spawn
 *                            counterfactual" CTA to /plan.
 *
 * Honest gaps: when something is missing we say so in stakeholder
 * language ("Couldn't locate the surrounding paragraph", "No sources
 * cited yet"), rather than leaving "coming next" roadmap promises.
 */

import Link from 'next/link';
import { Fragment, use, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Database,
  ExternalLink,
  Layers,
  Quote,
} from 'lucide-react';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  wb,
  type CellSummary,
  type Materialization,
  type ManifestStage,
  type RunCitation,
  type RunFinal,
  type SpecCurveRow,
} from '@/components/workbench/types';
import {
  agreementToneClass,
  cellDimensionLabel,
  cleanRepresentative,
  describeStage,
  extractCiteIds,
  extractClaimTitle,
  findClaimParagraph,
  formatSourceSummary,
  humanizeSpecKey,
  summarizeAgreement,
  summarizeCitations,
  unlabeledSourceFallback,
} from '@/components/evidence/claim-utils';
import { CounterScenarioPicker } from '@/components/evidence/counter-scenario-picker';
import { GroundedEvidenceBase } from '@/components/evidence/grounded-evidence-base';
import { ObservedInferredSplit } from '@/components/evidence/observed-inferred';
import { SourceCard } from '@/components/evidence/source-card';
import {
  extractVerifierFlags,
  findCiteSentence,
  groupCitations,
  type CitationGroup,
} from '@/components/evidence/source-helpers';
import { VerifierFlags } from '@/components/evidence/verifier-flags';
import { VerifyPanel } from '@/components/evidence/verify-panel';

type Loadable<T> = {
  loading: boolean;
  value: T | null;
  error: string | null;
};

function emptyLoadable<T>(): Loadable<T> {
  return { loading: true, value: null, error: null };
}

export default function EvidencePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const data = useStudyData();
  const { curve, loadingCurve, studyId } = data;

  const row: SpecCurveRow | null = useMemo(() => {
    if (!curve) return null;
    return curve.rows.find((r) => String(r.cluster_id) === id) ?? null;
  }, [curve, id]);

  // 1-based position of this finding in the ranked spec curve (matches
  // /research's ordering, so the simulation page can deep-link as
  // ?finding=N).
  const findingIndex = useMemo<number | null>(() => {
    if (!curve || !row) return null;
    const idx = curve.rows.findIndex((r) => r.cluster_id === row.cluster_id);
    return idx < 0 ? null : idx + 1;
  }, [curve, row]);

  const cells = useMemo(() => curve?.cells ?? [], [curve]);
  const agreeingCells: CellSummary[] = useMemo(() => {
    if (!row) return [];
    return cells.filter((c) => row.statuses[c.id] === 'agree');
  }, [row, cells]);
  const sourceCell = useMemo<CellSummary | null>(() => {
    if (!row) return null;
    if (agreeingCells.length > 0) return agreeingCells[0];
    return cells.find((c) => row.statuses[c.id]) ?? null;
  }, [row, agreeingCells, cells]);

  // ── Per-run data: final.json (sources) and materializations (stages)
  const [matsFetch, setMatsFetch] = useState<{
    runId: string;
    value: Materialization[] | null;
    error: string | null;
  } | null>(null);
  const [finalFetch, setFinalFetch] = useState<{
    runId: string;
    value: RunFinal | null;
    error: string | null;
  } | null>(null);

  // Manifest is the reliable source for per-stage model_id; the
  // dagster materializations endpoint can be empty for older runs.
  const [manifestFetch, setManifestFetch] = useState<{
    runId: string;
    stages: ManifestStage[] | null;
  } | null>(null);

  useEffect(() => {
    if (!sourceCell) return;
    let cancelled = false;
    const runId = sourceCell.run_id;
    wb.materializations(runId)
      .then((res) => {
        if (cancelled) return;
        setMatsFetch({
          runId,
          value: res.materializations,
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setMatsFetch({
          runId,
          value: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    wb.manifest(runId)
      .then((res) => {
        if (cancelled) return;
        setManifestFetch({ runId, stages: res.stages ?? [] });
      })
      .catch(() => {
        if (cancelled) return;
        setManifestFetch({ runId, stages: null });
      });
    wb.runFinal(runId)
      .then((res) => {
        if (cancelled) return;
        setFinalFetch({ runId, value: res, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setFinalFetch({
          runId,
          value: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [sourceCell]);

  // Pick a representative model_id for the ProvenanceLine. Prefer
  // dagster materializations (when present); fall back to manifest
  // stages. Within either source pick the stage that did the bulk of
  // the work, i.e. highest n_calls or spent_usd, with the personas /
  // interview / synthesis stages preferred over question_analysis.
  const leadModelId = useMemo<string | null>(() => {
    const stages: Array<Pick<Materialization, 'stage' | 'model_id' | 'n_calls' | 'spent_usd'>> =
      (matsFetch?.value ?? []).length > 0
        ? (matsFetch?.value ?? [])
        : (manifestFetch?.stages ?? []).map((s) => ({
            stage: s.stage,
            model_id: s.model_id,
            n_calls: undefined,
            spent_usd: s.elapsed_s, // proxy when n_calls/spent_usd missing
          }));
    if (stages.length === 0) return null;
    const PREFERRED = new Set([
      'interviews',
      'synthesis',
      'subreports',
      'perspective',
    ]);
    const score = (s: { stage: string; n_calls?: number | null; spent_usd?: number | null }) => {
      const base =
        (s.spent_usd ?? 0) > 0
          ? s.spent_usd ?? 0
          : (s.n_calls ?? 0);
      return PREFERRED.has(s.stage) ? base + 1e6 : base;
    };
    let best = stages[0];
    for (const s of stages.slice(1)) {
      if (score(s) > score(best)) best = s;
    }
    return best.model_id ?? null;
  }, [matsFetch, manifestFetch]);

  const currentRunId = sourceCell?.run_id ?? null;
  const mats: Loadable<Materialization[]> = useMemo(() => {
    if (!currentRunId) return { loading: false, value: null, error: null };
    if (matsFetch && matsFetch.runId === currentRunId) {
      return {
        loading: false,
        value: matsFetch.value,
        error: matsFetch.error,
      };
    }
    return emptyLoadable();
  }, [matsFetch, currentRunId]);

  const finalLoad: Loadable<RunFinal> = useMemo(() => {
    if (!currentRunId) return { loading: false, value: null, error: null };
    if (finalFetch && finalFetch.runId === currentRunId) {
      return {
        loading: false,
        value: finalFetch.value,
        error: finalFetch.error,
      };
    }
    return emptyLoadable();
  }, [finalFetch, currentRunId]);

  const citations: RunCitation[] = useMemo(
    () => finalLoad.value?.json?.citations ?? [],
    [finalLoad.value],
  );
  const summary = useMemo(() => summarizeCitations(citations), [citations]);
  // The representative often carries the prereg block, decision rule,
  // and verdict markdown stitched after the lead sentence. Run it
  // through cleanRepresentative first so the page H1 reads as a
  // single, prose-shaped claim rather than markdown noise.
  const claimTitle = row
    ? extractClaimTitle(cleanRepresentative(row.representative) || row.representative)
    : '';
  const paragraphMatch = useMemo(() => {
    if (!row || !finalLoad.value?.markdown) return null;
    return findClaimParagraph(finalLoad.value.markdown, row.representative);
  }, [row, finalLoad.value]);
  const referencedIds = useMemo(() => {
    if (!row) return [];
    const text = paragraphMatch?.paragraph ?? row.representative;
    return extractCiteIds(text);
  }, [row, paragraphMatch]);
  const sortedCitations = useMemo(() => {
    if (!citations.length || !referencedIds.length) return citations;
    const order = new Map(referencedIds.map((cite_id, i) => [cite_id, i]));
    return [...citations].sort((a, b) => {
      const ai = order.has(a.cite_id) ? (order.get(a.cite_id) ?? 999) : 1000;
      const bi = order.has(b.cite_id) ? (order.get(b.cite_id) ?? 999) : 1000;
      return ai - bi;
    });
  }, [citations, referencedIds]);
  const referencedCitations = sortedCitations.filter((c) =>
    referencedIds.includes(c.cite_id),
  );
  const otherCitations = sortedCitations.filter(
    (c) => !referencedIds.includes(c.cite_id),
  );
  // Group duplicates (same URL/host + same/garbage snippet) so cards
  // don't repeat. The "cited as [Sx] [Sy]" header on the primary card
  // preserves the alias trail.
  const referencedGroups = useMemo(
    () => groupCitations(referencedCitations),
    [referencedCitations],
  );
  const otherGroups = useMemo(
    () => groupCitations(otherCitations),
    [otherCitations],
  );
  // Verifier flags get promoted above the source cards. They're
  // computed from the union so we surface failures regardless of
  // whether the cite landed in the referenced or other bucket.
  const verifierFlags = useMemo(
    () => extractVerifierFlags(citations),
    [citations],
  );
  const claimParagraph = paragraphMatch?.paragraph ?? null;

  // The one-shot "Spawn a counter-scenario" CTA used to deep-link to
  // /plan. It is replaced by <CounterScenarioPicker>, which calls the
  // brainstorm endpoint and renders selectable cards. We still surface
  // the dimension hint so the user can scan the swap space at a
  // glance before the brainstorm returns.
  const counterfactualHint = useMemo(() => {
    if (!cells.length) return null;
    const dimensions = new Map<string, Set<string>>();
    for (const c of cells) {
      for (const [d, v] of Object.entries(c.axes)) {
        if (!dimensions.has(d)) dimensions.set(d, new Set());
        dimensions.get(d)!.add(v);
      }
    }
    const candidates = Array.from(dimensions.entries()).filter(
      ([, vs]) => vs.size > 1,
    );
    return candidates[0]?.[0] ?? null;
  }, [cells]);

  return (
    <StudyShell
      data={data}
      eyebrow={`Claim #${id}`}
      title={row ? claimTitle : 'Claim'}
      intro={
        row
          ? 'Walk from the sentence in the brief back to the sources, the steps, and the scenarios that tested it.'
          : 'Pick a claim from the evidence list.'
      }
      back={{
        href: row
          ? withStudy(`/scenario/${row.cluster_id}`, studyId)
          : withStudy('/evidence', studyId),
        label: 'Back to claims',
      }}
    >
      {!studyId ? null : loadingCurve || !curve ? (
        <FocusCard tone="muted">
          <div className="grid gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-20 animate-pulse rounded-2xl bg-slate-200/70"
              />
            ))}
          </div>
        </FocusCard>
      ) : !row ? (
        <FocusCard>
          <p className="text-sm text-slate-600">
            No claim <span className="font-mono">#{id}</span> on the
            current evidence list. The list rebuilds every load — open{' '}
            <Link
              href={withStudy('/evidence', studyId)}
              className="font-medium text-slate-900 underline-offset-4 hover:underline"
            >
              the claims list
            </Link>{' '}
            to pick another one.
          </p>
        </FocusCard>
      ) : (
        <div className="grid gap-3">
          <StickyClaimHeader
            row={row}
            studyId={studyId}
            claimTitle={claimTitle}
          />

          <VerifyPanel
            row={row}
            sources={summary}
            hasSources={summary.total > 0}
            loadingSources={finalLoad.loading}
          />

          {!finalLoad.loading && !finalLoad.error ? (
            <ObservedInferredSplit
              claim={claimTitle}
              citations={citations}
              row={row}
              referencedIds={referencedIds}
              studyId={studyId}
            />
          ) : null}

          <Step
            number={1}
            label="Claim"
            Icon={Quote}
            tone="emerald"
          >
            <ClaimBody
              row={row}
              paragraph={paragraphMatch?.paragraph ?? null}
              loading={finalLoad.loading}
              error={finalLoad.error}
            />
            <ProvenanceLine
              agreeingCells={agreeingCells}
              totalCellCount={cells.length}
              cells={cells}
              sourceCell={sourceCell}
              leadModelId={leadModelId}
            />
          </Step>

          <Connector />

          <Step
            number={2}
            label="Sources"
            Icon={Database}
            tone="blue"
          >
            <SourcesBody
              referencedGroups={referencedGroups}
              otherGroups={otherGroups}
              verifierFlags={verifierFlags}
              loading={finalLoad.loading}
              error={finalLoad.error}
              sourceCell={sourceCell}
              agreeingCellCount={agreeingCells.length}
              totalCellCount={cells.length}
              claimParagraph={claimParagraph}
            />
          </Step>

          <Connector />

          <Step
            number={3}
            label="Transformation"
            Icon={Layers}
            tone="violet"
          >
            <TransformationBody
              mats={mats.value}
              loading={mats.loading}
              error={mats.error}
              cell={sourceCell}
            />
          </Step>

          <Connector />

          <Step
            number={4}
            label="Robustness"
            Icon={CheckCircle2}
            tone="amber"
          >
            <RobustnessBody
              row={row}
              cells={cells}
              counterfactualHint={counterfactualHint}
              studyId={studyId}
              clusterId={row.cluster_id}
              findingIndex={findingIndex}
            />
          </Step>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Link
              href={withStudy('/evidence', studyId)}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 text-[12px] font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to claims
            </Link>
            <Link
              href={withStudy('/answer', studyId)}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-slate-950 px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
            >
              Back to the answer
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      )}
    </StudyShell>
  );
}

// ── Sticky claim header ────────────────────────────────────────────

function StickyClaimHeader({
  row,
  studyId,
  claimTitle,
}: {
  row: SpecCurveRow;
  studyId: string | null;
  claimTitle: string;
}) {
  const agree = summarizeAgreement(row);
  return (
    <div className="sticky top-2 z-10 -mx-1 rounded-2xl border border-slate-200 bg-white/95 px-3 py-2 shadow-sm backdrop-blur sm:top-3 sm:px-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Verifying claim
          </p>
          <p className="truncate text-sm font-semibold text-slate-900">
            {claimTitle}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]',
              agreementToneClass(agree.tone),
            )}
          >
            {agree.text}
          </span>
          <Link
            href={withStudy(`/scenario/${row.cluster_id}`, studyId)}
            className="hidden rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 sm:inline-flex"
          >
            View scenario detail
          </Link>
        </div>
      </div>
    </div>
  );
}

// ── Step shell + connector ─────────────────────────────────────────

function Step({
  number,
  label,
  Icon,
  tone,
  children,
}: {
  number: number;
  label: string;
  Icon: typeof Quote;
  tone: 'emerald' | 'blue' | 'violet' | 'amber';
  children: React.ReactNode;
}) {
  const cls = {
    emerald: 'border-emerald-200 bg-emerald-100 text-emerald-700',
    blue: 'border-blue-200 bg-blue-100 text-blue-700',
    violet: 'border-violet-200 bg-violet-100 text-violet-700',
    amber: 'border-amber-200 bg-amber-100 text-amber-700',
  }[tone];
  return (
    <FocusCard>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
        <div
          className={cn(
            'grid h-9 w-9 place-items-center rounded-xl border font-mono text-[10px] font-bold uppercase tabular-nums shadow-sm',
            cls,
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 grid gap-2">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Step {number}
            </span>
            <h3 className="text-sm font-semibold tracking-tight text-slate-900">
              {label}
            </h3>
          </div>
          <div>{children}</div>
        </div>
      </div>
    </FocusCard>
  );
}

function Connector() {
  return (
    <div className="grid place-items-center text-slate-300">
      <ArrowDown className="h-4 w-4" />
    </div>
  );
}

// ── Step 1: Claim body ─────────────────────────────────────────────

function ClaimBody({
  row,
  paragraph,
  loading,
  error,
}: {
  row: SpecCurveRow;
  paragraph: string | null;
  loading: boolean;
  error: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  // Strip the pre-registration block, verdict markdown, and signed-by
  // line out of the cluster representative before showing it in the
  // blockquote. The first sentence usually carries the claim itself.
  const claimSentence = useMemo(
    () => cleanRepresentative(row.representative),
    [row],
  );
  const cleanedRep = useMemo(() => {
    if (!claimSentence) return '';
    const firstSentence = claimSentence.split(/(?<=[.!?])\s+/)[0] ?? claimSentence;
    // Allow a short follow-up phrase but cap at ~300 chars so the
    // blockquote stays scannable even when the lead sentence is long.
    return firstSentence.length > 320
      ? `${firstSentence.slice(0, 317)}…`
      : firstSentence;
  }, [claimSentence]);
  const hasParagraph =
    paragraph != null && paragraph.length > cleanedRep.length + 30;
  return (
    <div className="grid gap-2">
      <blockquote className="rounded-2xl border-l-4 border-emerald-200 bg-emerald-50/40 px-4 py-3 text-[14px] leading-relaxed text-slate-800">
        “{cleanedRep}”
      </blockquote>
      {error ? (
        <p className="text-[12px] text-orange-700">
          Couldn&apos;t load the brief to fetch the surrounding paragraph:{' '}
          {error}
        </p>
      ) : loading ? (
        <p className="text-[12px] text-slate-500">
          Loading the surrounding paragraph from the brief…
        </p>
      ) : paragraph == null ? (
        <p className="text-[12px] text-slate-500">
          Couldn&apos;t locate the surrounding paragraph in the brief.
          The claim above is the verbatim cluster representative.
        </p>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
          <p
            className={cn(
              'whitespace-pre-wrap text-[12px] leading-relaxed text-slate-700',
              !expanded && hasParagraph && 'line-clamp-3',
            )}
          >
            {renderParagraph(paragraph, claimSentence)}
          </p>
          {hasParagraph ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 text-[11px] font-medium text-slate-700 underline-offset-2 hover:underline"
            >
              {expanded ? 'Show less' : 'Show full paragraph'}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

// Render a brief paragraph with the cluster's representative sentence
// wrapped in <mark> for subtle highlighting, and every [Sn] / [Bn] /
// [Qn] citation marker bolded so the reader can scan what's cited.
function renderParagraph(
  paragraph: string,
  sentence: string,
): React.ReactNode {
  const sentenceIdx = sentence ? locateSentence(paragraph, sentence) : -1;
  if (sentenceIdx === -1) {
    return boldCiteMarkers(paragraph);
  }
  const before = paragraph.slice(0, sentenceIdx);
  // Walk to the end of the matched sentence (after first '.' / '!' / '?'
  // following the probe). This captures the cite markers that often
  // sit at the tail of the sentence.
  let end = sentenceIdx;
  while (end < paragraph.length) {
    const ch = paragraph.charCodeAt(end);
    if (ch === 46 || ch === 33 || ch === 63) {
      end += 1;
      break;
    }
    end += 1;
  }
  // Include any immediately trailing cite markers like " [S3]".
  while (end < paragraph.length && /[\s\[]/.test(paragraph[end])) {
    if (paragraph[end] === '[') {
      const close = paragraph.indexOf(']', end);
      if (close === -1) break;
      end = close + 1;
    } else {
      end += 1;
    }
  }
  const matched = paragraph.slice(sentenceIdx, end);
  const after = paragraph.slice(end);
  return (
    <>
      {boldCiteMarkers(before)}
      <mark className="bg-emerald-100/80 px-0.5 text-slate-900">
        {boldCiteMarkers(matched)}
      </mark>
      {boldCiteMarkers(after)}
    </>
  );
}

function locateSentence(paragraph: string, sentence: string): number {
  const probe = sentence
    .replace(/\s*\[(S|B|Q)\d+\](\s*\[(S|B|Q)\d+\])*/g, '')
    .slice(0, 60)
    .trim();
  if (probe.length < 24) return -1;
  return paragraph.indexOf(probe);
}

const CITE_TOKEN_RE = /(\[(?:S|B|Q)\d+\])/g;
const CITE_TOKEN_TEST = /^\[(?:S|B|Q)\d+\]$/;

function boldCiteMarkers(text: string): React.ReactNode {
  if (!text) return text;
  const parts = text.split(CITE_TOKEN_RE);
  return parts.map((part, i) =>
    CITE_TOKEN_TEST.test(part) ? (
      <strong key={i} className="font-semibold text-slate-900">
        {part}
      </strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

// ── ProvenanceLine ─────────────────────────────────────────────────

type BriefSummary = {
  runId: string;
  loading: boolean;
  sentence: string | null;
  error: string | null;
};

function ProvenanceLine({
  agreeingCells,
  totalCellCount,
  cells,
  sourceCell,
  leadModelId,
}: {
  agreeingCells: CellSummary[];
  totalCellCount: number;
  cells: CellSummary[];
  sourceCell: CellSummary | null;
  leadModelId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [briefs, setBriefs] = useState<Record<string, BriefSummary>>({});
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const pending = inFlight.current;
    for (const cell of agreeingCells) {
      if (briefs[cell.run_id] || pending.has(cell.run_id)) continue;
      pending.add(cell.run_id);
      setBriefs((b) => ({
        ...b,
        [cell.run_id]: {
          runId: cell.run_id,
          loading: true,
          sentence: null,
          error: null,
        },
      }));
      wb.runFinal(cell.run_id)
        .then((res) => {
          if (cancelled) return;
          const sentence = extractLeadSentence(res);
          setBriefs((b) => ({
            ...b,
            [cell.run_id]: {
              runId: cell.run_id,
              loading: false,
              sentence,
              error: null,
            },
          }));
        })
        .catch((err) => {
          if (cancelled) return;
          setBriefs((b) => ({
            ...b,
            [cell.run_id]: {
              runId: cell.run_id,
              loading: false,
              sentence: null,
              error: err instanceof Error ? err.message : String(err),
            },
          }));
        })
        .finally(() => {
          pending.delete(cell.run_id);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, agreeingCells, briefs]);

  const agreeingCount = agreeingCells.length;
  const dimensionLabel = sourceCell
    ? humanizeSpecKey(sourceCell.id, cells)
    : '';

  if (agreeingCount === 0 && !sourceCell) return null;

  return (
    <div className="mt-2 rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-2 text-[12px] leading-snug text-slate-700">
      <p>
        Synthesized from{' '}
        <strong className="font-semibold text-slate-900">
          {agreeingCount} of {totalCellCount}
        </strong>{' '}
        agreeing scenario briefs. Cluster representative chosen by{' '}
        <strong className="font-semibold text-slate-900">
          highest spec-curve agreement
        </strong>
        . Lead brief produced by{' '}
        <code className="rounded bg-white px-1 py-0.5 font-mono text-[11px] text-slate-800">
          {leadModelId ?? 'an LLM (model id unavailable for this run)'}
        </code>
        {dimensionLabel ? (
          <>
            {' '}under{' '}
            <em className="font-medium not-italic text-slate-800">
              {dimensionLabel}
            </em>
          </>
        ) : null}
        .{' '}
        {agreeingCount > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="font-semibold text-slate-900 underline-offset-2 hover:underline"
          >
            {open
              ? 'Hide agreeing briefs'
              : `Show all ${agreeingCount} agreeing briefs →`}
          </button>
        ) : null}
      </p>
      {open && agreeingCount > 0 ? (
        <ul className="mt-2 grid gap-1.5">
          {agreeingCells.map((cell) => {
            const brief = briefs[cell.run_id];
            const label = humanizeSpecKey(cell.id, cells);
            return (
              <li
                key={cell.id}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2"
              >
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  {label}
                </p>
                <p className="mt-0.5 text-[12px] text-slate-700">
                  {brief?.loading
                    ? 'Loading…'
                    : brief?.error
                      ? `Could not load brief: ${brief.error}`
                      : (brief?.sentence ??
                        'No lead sentence available in this brief.')}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function extractLeadSentence(res: RunFinal): string | null {
  // Prefer the first directive sentence from final.json's outline /
  // headline; fall back to the first non-heading line of markdown.
  const md = res.markdown ?? res.json?.markdown ?? '';
  if (!md) return null;
  const cleaned = cleanRepresentative(md);
  const sentence = cleaned.split(/(?<=[.!?])\s+/)[0] ?? cleaned;
  const trimmed = sentence.trim();
  if (!trimmed) return null;
  return trimmed.length > 320 ? `${trimmed.slice(0, 317)}…` : trimmed;
}

// ── Step 2: Sources body ───────────────────────────────────────────

function SourcesBody({
  referencedGroups,
  otherGroups,
  verifierFlags,
  loading,
  error,
  sourceCell,
  agreeingCellCount,
  totalCellCount,
  claimParagraph,
}: {
  referencedGroups: CitationGroup[];
  otherGroups: CitationGroup[];
  verifierFlags: ReturnType<typeof extractVerifierFlags>;
  loading: boolean;
  error: string | null;
  sourceCell: CellSummary | null;
  agreeingCellCount: number;
  totalCellCount: number;
  claimParagraph: string | null;
}) {
  if (!sourceCell) {
    return (
      <p className="text-[13px] text-slate-600">
        No scenario voted &ldquo;agree&rdquo; for this claim yet. It is a
        candidate the synthesizer raised but no defensible framing has
        supported.
      </p>
    );
  }
  if (loading) {
    return (
      <div className="grid gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-2xl bg-slate-200/70"
          />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <p className="text-[12px] text-orange-700">
        Couldn&apos;t load the brief to extract citations: {error}
      </p>
    );
  }

  const dimensionLabel = cellDimensionLabel(sourceCell);
  const referencedCitations = referencedGroups.flatMap((g) => g.members);
  const otherCitations = otherGroups.flatMap((g) => g.members);
  const totalCited = referencedCitations.length + otherCitations.length;
  const summary = summarizeCitations([
    ...referencedCitations,
    ...otherCitations,
  ]);
  const scenarioCount = agreeingCellCount > 0 ? agreeingCellCount : 1;

  return (
    <div className="grid gap-3">
      <p className="text-[12px] leading-snug text-slate-600">
        Quoted from the brief produced by{' '}
        <span className="font-medium text-slate-800">{dimensionLabel}</span>.{' '}
        {agreeingCellCount > 0 ? (
          <>
            {agreeingCellCount} of {totalCellCount}{' '}
            {totalCellCount === 1 ? 'scenario' : 'scenarios'} produced a
            brief that supports this claim.
          </>
        ) : (
          <>No scenarios fully agree; this is the closest brief.</>
        )}
      </p>

      <VerifierFlags flags={verifierFlags} />

      <GroundedEvidenceBase
        citations={[...referencedCitations, ...otherCitations]}
      />

      {totalCited === 0 ? (
        <p className="text-[13px] text-slate-600">
          The brief did not cite any verifiable sources for this claim
          ({totalCellCount === 1 ? 'a known gap for single-scenario studies' : 'investigate the source cell'}).{' '}
          <span className="text-slate-500">
            Source cell:{' '}
            <span className="font-mono text-[11px]">{sourceCell.id}</span>{' '}
            ·{' '}
            <span className="font-mono text-[11px]">
              {unlabeledSourceFallback(sourceCell.run_id)}
            </span>
          </span>
        </p>
      ) : (
        <>
          {referencedGroups.length > 0 ? (
            <div className="grid gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Cited in this claim ({referencedCitations.length})
              </p>
              <div className="grid gap-2">
                {referencedGroups.map((group) => (
                  <SourceCard
                    key={group.primary.cite_id}
                    citation={group.primary}
                    aliases={group.aliases}
                    preferredSnippet={findCiteSentence(
                      claimParagraph,
                      group.primary.cite_id,
                    )}
                    extraSnippets={group.snippets.slice(1)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-slate-500">
              The claim text does not reference specific citations; the
              brief used {totalCited} source
              {totalCited === 1 ? '' : 's'} across the full paragraph —
              listed below.
            </p>
          )}

          {otherGroups.length > 0 ? (
            <details className="rounded-2xl border border-slate-200 bg-white">
              <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-slate-700">
                Other sources in this brief ({otherCitations.length})
              </summary>
              <div className="grid gap-2 border-t border-slate-200 p-3">
                {otherGroups.map((group) => (
                  <SourceCard
                    key={group.primary.cite_id}
                    citation={group.primary}
                    aliases={group.aliases}
                    preferredSnippet={findCiteSentence(
                      claimParagraph,
                      group.primary.cite_id,
                    )}
                    extraSnippets={group.snippets.slice(1)}
                  />
                ))}
              </div>
            </details>
          ) : null}

          <PartialSourcesNote
            referenced={referencedCitations}
            total={totalCited}
            scenarios={scenarioCount}
            summary={summary}
          />
        </>
      )}
    </div>
  );
}

function PartialSourcesNote({
  referenced,
  total,
  scenarios,
  summary,
}: {
  referenced: RunCitation[];
  total: number;
  scenarios: number;
  summary: ReturnType<typeof summarizeCitations>;
}) {
  // Surface partial-evidence honesty: if some citations are unverified
  // or the brief shipped fewer sources than scenarios, say so.
  const unverified = referenced.filter((c) => c.verified === false).length;
  if (unverified === 0 && scenarios <= 1 && total <= 10) return null;
  return (
    <p className="text-[11px] leading-snug text-slate-500">
      Provenance check: {formatSourceSummary(summary)} across {scenarios}{' '}
      {scenarios === 1 ? 'scenario' : 'scenarios'}.
      {unverified > 0
        ? ` ${unverified} of these failed automated verification —
            treat them as background context, not load-bearing evidence.`
        : ''}
    </p>
  );
}

// ── Step 3: Transformation body ────────────────────────────────────

function TransformationBody({
  mats,
  loading,
  error,
  cell,
}: {
  mats: Materialization[] | null;
  loading: boolean;
  error: string | null;
  cell: CellSummary | null;
}) {
  if (!cell) {
    return (
      <p className="text-[13px] text-slate-600">
        No source cell to draw a transformation chain from.
      </p>
    );
  }
  if (error) {
    return (
      <p className="text-[12px] text-orange-700">
        Couldn&apos;t load the pipeline receipt for this run: {error}
      </p>
    );
  }
  if (loading || !mats) {
    return (
      <div className="grid gap-1">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-10 animate-pulse rounded-xl bg-slate-200/70"
          />
        ))}
      </div>
    );
  }
  if (mats.length === 0) {
    return (
      <p className="text-[12px] text-slate-600">
        No pipeline receipt on disk for this run yet — the runner writes
        one line per step as it completes.
      </p>
    );
  }

  const steps = mats.map(describeStage);
  const totalElapsed = mats.reduce((acc, m) => acc + (m.elapsed_s ?? 0), 0);
  const totalSpend = mats.reduce((acc, m) => acc + (m.spent_usd ?? 0), 0);
  const totalCalls = mats.reduce((acc, m) => acc + (m.n_calls ?? 0), 0);

  return (
    <div className="grid gap-2">
      <ol className="grid gap-1.5">
        {steps.map((s, i) => (
          <li
            key={`${s.raw_stage}-${i}`}
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm"
          >
            <span className="grid h-6 w-6 place-items-center rounded-md bg-slate-100 font-mono text-[10px] font-bold text-slate-600">
              {String(i + 1).padStart(2, '0')}
            </span>
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-slate-900">
                {s.title}
              </p>
              <p className="text-[11px] leading-snug text-slate-600">
                {s.description}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <details className="mt-1 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-3 py-2">
        <summary className="cursor-pointer text-[11px] font-medium text-slate-600">
          Show raw timings and cost ({totalElapsed.toFixed(1)}s ·{' '}
          {totalCalls} calls · ${totalSpend.toFixed(4)})
        </summary>
        <ul className="mt-2 grid gap-1.5">
          {mats.map((m, i) => (
            <li
              key={`raw-${m.stage}-${i}`}
              className="flex flex-wrap items-baseline gap-2 rounded-lg bg-white px-2 py-1 text-[11px] shadow-inner"
            >
              <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="font-mono text-[11px] font-semibold text-slate-900">
                {m.stage}
              </span>
              {m.model_id ? (
                <Badge
                  variant="outline"
                  className="border-slate-200 bg-slate-50 font-mono text-[9px] text-slate-600"
                >
                  {m.model_id}
                </Badge>
              ) : null}
              {m.elapsed_s != null ? (
                <span className="font-mono text-[10px] text-slate-500">
                  {m.elapsed_s.toFixed(1)}s
                </span>
              ) : null}
              {m.spent_usd != null ? (
                <span className="ml-auto font-mono text-[10px] text-slate-500">
                  ${m.spent_usd.toFixed(4)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="mt-2 flex items-center gap-1 text-[10px] text-slate-500">
          <ExternalLink className="h-3 w-3" />
          Receipt path:{' '}
          <code className="font-mono">
            runs/{cell.run_id}/dagster_materializations.jsonl
          </code>
        </p>
      </details>
    </div>
  );
}

// ── Step 4: Robustness body ────────────────────────────────────────

function RobustnessBody({
  row,
  cells,
  counterfactualHint,
  studyId,
  clusterId,
  findingIndex,
}: {
  row: SpecCurveRow;
  cells: CellSummary[];
  counterfactualHint: string | null;
  studyId: string | null;
  clusterId: number;
  findingIndex: number | null;
}) {
  const agree = summarizeAgreement(row);
  const total = agree.total;
  const agreeCount = agree.agree;
  const pct = total > 0 ? agreeCount / total : 0;
  const barTone =
    agree.tone === 'strong'
      ? 'bg-emerald-500'
      : agree.tone === 'mixed'
        ? 'bg-yellow-500'
        : agree.tone === 'weak'
          ? 'bg-orange-500'
          : 'bg-slate-300';

  return (
    <div className="grid gap-3">
      <p className="text-[14px] leading-relaxed text-slate-800">
        {total === 0 ? (
          'Not yet evaluated across any scenario.'
        ) : (
          <>
            Holds in <span className="font-semibold">{agreeCount}</span> of{' '}
            <span className="font-semibold">{total}</span>{' '}
            {total === 1 ? 'scenario' : 'scenarios'} so far.
            {total <= 1
              ? ' Add more scenarios to stress-test.'
              : row.n_flips > 0
                ? ` ${row.n_flips} scenario${row.n_flips === 1 ? '' : 's'} flip the claim — investigate before relying on it.`
                : ''}
          </>
        )}
      </p>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
        aria-label={`${agreeCount} of ${total} scenarios agree`}
      >
        <div
          className={cn('h-full transition-[width]', barTone)}
          style={{ width: `${Math.max(pct * 100, total > 0 ? 6 : 0)}%` }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
        <Legend tone="emerald" label={`agree ${row.n_agree}`} />
        <Legend tone="amber" label={`weaker ${row.n_weaker}`} />
        <Legend tone="orange" label={`flip ${row.n_flips}`} />
        <Legend tone="slate" label={`missing ${row.n_missing}`} />
      </div>
      {row.fragile_specs.length > 0 ? (
        <p className="text-[12px] text-slate-600">
          <span className="font-semibold text-slate-700">Fragile under:</span>{' '}
          {row.fragile_specs
            .slice(0, 3)
            .map((spec) => humanizeSpecKey(spec, cells))
            .join('; ')}
          {row.fragile_specs.length > 3
            ? ` (+${row.fragile_specs.length - 3} more)`
            : ''}
        </p>
      ) : null}
      <div className="grid gap-1.5">
        <CounterScenarioPicker
          studyId={studyId}
          clusterId={clusterId}
          findingIndex={findingIndex}
        />
        {counterfactualHint ? (
          <p className="text-[11px] text-slate-500">
            Suggestion: swap the{' '}
            <span className="font-medium text-slate-700">
              {counterfactualHint}
            </span>{' '}
            dimension to a value this study hasn&apos;t tested yet.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Legend({
  tone,
  label,
}: {
  tone: 'emerald' | 'amber' | 'orange' | 'slate';
  label: string;
}) {
  const cls = {
    emerald: 'bg-emerald-500',
    amber: 'bg-yellow-500',
    orange: 'bg-orange-500',
    slate: 'bg-slate-300',
  }[tone];
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('h-2 w-2 rounded-full', cls)} />
      <span className="font-mono">{label}</span>
    </span>
  );
}

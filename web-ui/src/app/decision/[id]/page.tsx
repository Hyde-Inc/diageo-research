'use client';

/**
 * /decision/[id] — one committed decision, end-to-end.
 *
 * Maya commits a decision from /simulation; this page is where the loop
 * closes. It renders:
 *
 *   - the recommendation as H1 + a "Committed by X on T for study Y"
 *     subhead,
 *   - the confidence sentence in the same plain language /research uses,
 *   - a scope card linking back to /growth-driver?driver=… or
 *     /research?finding=… so the round-trip stays intact,
 *   - "What could break this" (fragile assumption),
 *   - each counterfactual_ref as a card (prompt + variant inputs +
 *     assumes / does-not-assume + math), each clickable to
 *     /assets/<cf.asset_key_encoded>,
 *   - the inputs_used list with /evidence links where resolvable,
 *   - a folded "Verifier detail" disclosure exposing snapshot hashes,
 *   - a right-rail "What changed since I committed this?" CTA that
 *     calls GET /decisions/{id}/in-year and renders a plain-language
 *     diff (M5 / FR-DC-2).
 *
 * Honors any ILLUSTRATIVE chip carried on the underlying counterfactual.
 * No jargon — no "spec curve", no "lens", no "falsifier".
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Compass,
  FileSearch,
  History,
  Info,
  Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { cn } from '@/lib/utils';
import {
  wb,
  type AssetSummary,
  type DecisionInYearResponse,
  type DecisionRecord,
} from '@/components/workbench/types';

type DecisionFetch = {
  id: string;
  record: DecisionRecord | null;
  counterfactuals: CfRow[];
  error: string | null;
};

type CfRow = {
  cfId: string;
  assetKeyEncoded: string | null;
  prompt: string | null;
  variants: unknown[];
  inputs: unknown[];
  assumes: string[];
  doesNotAssume: string[];
  illustrative: boolean | null;
};

type InYearState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'loaded'; response: DecisionInYearResponse }
  | { kind: 'error'; message: string };

export default function DecisionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const data = useStudyData();
  const router = useRouter();
  const [fetched, setFetched] = useState<DecisionFetch | null>(null);
  const [inYear, setInYear] = useState<InYearState>({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      wb.decision(id),
      wb.assets({ kind: 'counterfactual', limit: 500 }),
    ])
      .then(([record, list]) => {
        if (cancelled) return;
        const counterfactuals = matchCounterfactuals(
          record.counterfactual_refs || [],
          list.assets || [],
        );
        setFetched({ id, record, counterfactuals, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setFetched({
          id,
          record: null,
          counterfactuals: [],
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Derive load state from the fetched payload so we avoid a synchronous
  // setState inside the effect body.
  const isFetched = fetched?.id === id;
  const loading = !isFetched;
  const record = isFetched ? fetched!.record : null;
  const counterfactuals = isFetched ? fetched!.counterfactuals : [];
  const fetchError = isFetched ? fetched!.error : null;
  const studyId = record?.scope?.study_id ?? data.studyId ?? null;
  const studyLabel = useMemo(() => {
    if (!record) return null;
    if (!studyId) return null;
    const known = data.studies.find((s) => s.id === studyId);
    return known?.name ?? studyId;
  }, [record, studyId, data.studies]);

  const handleInYear = async () => {
    if (!record) return;
    setInYear({ kind: 'pending' });
    try {
      const response = await wb.decisionInYear(id);
      setInYear({ kind: 'loaded', response });
    } catch (err) {
      setInYear({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const backHref = withStudy('/assets', studyId);
  const handleBack = () => {
    // window.history is only available client-side, but this is a
    // 'use client' component so we can branch on history.length>1.
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.push(backHref);
    }
  };
  return (
    <StudyShell
      data={data}
      eyebrow="Committed decision"
      title={record ? record.recommendation : 'Decision'}
      back={{ href: backHref, label: 'Back', onClick: handleBack }}
      contentClassName="max-w-[1200px]"
      mainLabel="Decision detail"
      rightLabel="In-year action"
      main={
        loading ? (
          <FocusCard tone="muted">
            <p className="text-sm text-slate-500">Loading committed decision…</p>
          </FocusCard>
        ) : fetchError || !record ? (
          <FocusCard tone="muted" className="border-orange-200 bg-orange-50">
            <p className="text-sm font-medium text-orange-800">
              Couldn’t load this decision: {fetchError ?? 'not found'}
            </p>
          </FocusCard>
        ) : (
          <DecisionBody
            record={record}
            counterfactuals={counterfactuals}
            studyId={studyId}
            studyLabel={studyLabel}
          />
        )
      }
      right={
        record ? (
          <InYearPanel
            state={inYear}
            committedAt={record.committed_at}
            onRun={handleInYear}
          />
        ) : null
      }
    />
  );
}

function DecisionBody({
  record,
  counterfactuals,
  studyId,
  studyLabel,
}: {
  record: DecisionRecord;
  counterfactuals: CfRow[];
  studyId: string | null;
  studyLabel: string | null;
}) {
  const scope = record.scope ?? {};
  const driverId = scope.driver_id || null;
  const findingId = scope.finding_id || null;
  const scopeBackLink = driverId
    ? withStudy('/growth-driver', studyId, { driver: driverId })
    : findingId
      ? withStudy('/research', studyId, { finding: findingIndexOf(findingId) })
      : null;

  return (
    <div className="grid gap-4">
      <FocusCard>
        <div className="grid gap-2">
          <p className="text-[12px] leading-snug text-slate-500">
            Committed by{' '}
            <span className="font-medium text-slate-700">{record.owner}</span>{' '}
            on {formatCommittedAt(record.committed_at)}
            {record.mbp ? (
              <>
                {' in '}
                <span className="font-medium text-slate-700">
                  {[
                    record.mbp.mbp_name,
                    record.mbp.must_do,
                    record.mbp.driver,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                .
              </>
            ) : findingId ? (
              <>
                {' for finding '}
                <span className="font-medium text-slate-700">
                  {humaniseSlug(findingId)}
                </span>{' '}
                in study{' '}
                <span className="font-medium text-slate-700">
                  {studyLabel ?? scope.study_id ?? '—'}
                </span>
                .
              </>
            ) : (
              <>
                {' for study '}
                <span className="font-medium text-slate-700">
                  {studyLabel ?? scope.study_id ?? '—'}
                </span>
                .
              </>
            )}
          </p>
          <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Confidence
            </div>
            <p className="mt-1 text-sm font-medium text-slate-900">
              {record.confidence.holds_in} of {record.confidence.of} scenarios
              support this — labeled{' '}
              <span className="text-slate-950">{record.confidence.label}</span>.
            </p>
            <p className="mt-1 text-[12px] leading-snug text-slate-600">
              {record.confidence.sentence}
            </p>
          </div>
        </div>
      </FocusCard>

      <FocusCard>
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Scope
        </h2>
        <div className="mt-2 grid gap-2 text-sm text-slate-700">
          <div>
            Study:{' '}
            <span className="font-medium text-slate-950">
              {studyLabel ?? scope.study_id ?? '—'}
            </span>
          </div>
          {driverId ? (
            <div>
              Growth driver:{' '}
              <span className="font-medium text-slate-950">
                {humaniseSlug(driverId)}
              </span>
            </div>
          ) : null}
          {findingId ? (
            <div>
              Research finding:{' '}
              <span className="font-medium text-slate-950">
                {humaniseSlug(findingId)}
              </span>
            </div>
          ) : null}
        </div>
        {scopeBackLink ? (
          <Link
            href={scopeBackLink}
            className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-slate-700 underline-offset-2 hover:text-slate-950 hover:underline"
          >
            Open the originating page
            <ArrowRight className="h-3 w-3" />
          </Link>
        ) : null}
      </FocusCard>

      <FocusCard>
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5" />
          What could break this
        </div>
        <p className="mt-2 text-sm leading-snug text-slate-800">
          {record.fragile_assumption?.trim() ||
            'No fragile assumption was captured at commit time.'}
        </p>
      </FocusCard>

      <CounterfactualsSection
        refs={record.counterfactual_refs || []}
        rows={counterfactuals}
      />

      <InputsSection inputs={record.inputs_used || []} />

      <SnapshotDisclosure record={record} />
    </div>
  );
}

function CounterfactualsSection({
  refs,
  rows,
}: {
  refs: string[];
  rows: CfRow[];
}) {
  if (refs.length === 0) {
    return (
      <FocusCard tone="muted" className="border-dashed">
        <p className="text-sm leading-snug text-slate-600">
          No counterfactuals were attached to this decision.
        </p>
      </FocusCard>
    );
  }
  return (
    <section className="grid gap-3">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        <Sparkles className="h-3.5 w-3.5" />
        Counterfactuals committed alongside this decision
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {refs.map((cfId) => {
          const row = rows.find((r) => r.cfId === cfId);
          return <CounterfactualCard key={cfId} cfId={cfId} row={row} />;
        })}
      </div>
    </section>
  );
}

function CounterfactualCard({ cfId, row }: { cfId: string; row: CfRow | undefined }) {
  const variant = pickFirstVariant(row?.variants ?? []);
  const promptSlug = isPromptSlug(row?.prompt) ? row?.prompt ?? null : null;
  const title = humaniseCfTitle({
    variantTitle: variant?.title ?? null,
    promptSlug,
    fallback: row?.prompt ?? cfId,
  });
  return (
    <article className="grid gap-3 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-950/[0.03]">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Counterfactual
          </span>
          <h3 className="mt-1 text-sm font-semibold tracking-tight text-slate-950">
            {title}
          </h3>
          {promptSlug ? (
            <span className="mt-1 inline-flex w-fit items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
              {promptSlug}
            </span>
          ) : null}
        </div>
        {row?.illustrative ? (
          <Badge
            variant="outline"
            className="border-amber-300 bg-amber-50 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-800"
          >
            Illustrative
          </Badge>
        ) : null}
      </header>

      {variant ? (
        <>
          {variant.directional ? (
            <p className="text-[12px] leading-snug text-slate-700">
              {variant.directional}
            </p>
          ) : null}
          {variant.math ? (
            <code className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-700">
              {variant.math}
            </code>
          ) : null}
        </>
      ) : null}

      {row?.inputs && row.inputs.length > 0 ? (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Inputs
          </div>
          <ul className="mt-1 grid gap-1">
            {row.inputs.map((input, idx) => (
              <li
                key={idx}
                className="flex items-start gap-2 text-[12px] leading-snug text-slate-700"
              >
                <FileSearch className="mt-0.5 h-3 w-3 shrink-0 text-slate-500" />
                <span>{renderInput(input)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {row?.assumes && row.assumes.length > 0 ? (
        <details className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3 text-[12px] text-slate-700">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-slate-600">
            Assumes / doesn&apos;t assume
          </summary>
          <div className="mt-2 grid gap-2">
            <BulletList items={row.assumes} tone="emerald" />
            <BulletList items={row.doesNotAssume} tone="orange" />
          </div>
        </details>
      ) : null}

      {row?.assetKeyEncoded ? (
        <Link
          href={`/assets/${row.assetKeyEncoded}`}
          className="inline-flex w-fit items-center gap-1 text-[12px] font-semibold text-slate-700 underline-offset-2 hover:text-slate-950 hover:underline"
        >
          Open counterfactual asset
          <ArrowRight className="h-3 w-3" />
        </Link>
      ) : (
        <p className="text-[11px] text-slate-500">
          Counterfactual asset not yet indexed —{' '}
          <span className="font-mono">{cfId.slice(0, 12)}…</span>
        </p>
      )}
    </article>
  );
}

function BulletList({
  items,
  tone,
}: {
  items: string[];
  tone: 'emerald' | 'orange';
}) {
  if (items.length === 0) return null;
  const Icon = tone === 'emerald' ? CheckCircle2 : AlertTriangle;
  const iconClass = tone === 'emerald' ? 'text-emerald-600' : 'text-orange-500';
  return (
    <ul className="grid gap-1">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2 leading-snug">
          <Icon className={cn('mt-0.5 h-3 w-3 shrink-0', iconClass)} />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function InputsSection({ inputs }: { inputs: string[] }) {
  if (inputs.length === 0) return null;
  return (
    <FocusCard>
      <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        <FileSearch className="h-3.5 w-3.5" />
        Inputs used
      </h2>
      <ul className="mt-2 grid gap-2">
        {inputs.map((input) => {
          const looksLikeEncodedKey = isLikelyEncodedAssetKey(input);
          const content = (
            <span className="text-sm leading-snug text-slate-700">{input}</span>
          );
          return (
            <li key={input}>
              {looksLikeEncodedKey ? (
                <Link
                  href={`/evidence/${input}`}
                  className="inline-flex items-start gap-2 underline-offset-2 hover:text-slate-950 hover:underline"
                >
                  {content}
                </Link>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ul>
    </FocusCard>
  );
}

function SnapshotDisclosure({ record }: { record: DecisionRecord }) {
  const s = record.snapshot ?? {
    evidence_hash: '',
    claims_hash: '',
    curve_hash: '',
    evidence_pointers: [],
    claim_ids: [],
  };
  return (
    <details className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3 text-[12px] text-slate-700">
      <summary className="flex cursor-pointer items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-600">
        <Info className="h-3.5 w-3.5" />
        Verifier detail (snapshot hashes)
      </summary>
      <div className="mt-2 grid gap-2">
        <HashRow label="Evidence" value={s.evidence_hash} />
        <HashRow label="Claims" value={s.claims_hash} />
        <HashRow label="Spec curve" value={s.curve_hash} />
        <p className="text-[11px] text-slate-500">
          Pointers tracked: {s.evidence_pointers?.length ?? 0} · claims tracked:{' '}
          {s.claim_ids?.length ?? 0}
        </p>
        <p className="text-[11px] text-slate-500">
          Asset key:{' '}
          <span className="font-mono">{record.asset_key_path.join(' / ')}</span>
        </p>
      </div>
    </details>
  );
}

function HashRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 text-[11px]">
      <span className="text-slate-500">{label}</span>
      <span className="truncate font-mono text-slate-700">
        {value || 'not recorded'}
      </span>
    </div>
  );
}

function InYearPanel({
  state,
  committedAt,
  onRun,
}: {
  state: InYearState;
  committedAt: string;
  onRun: () => void;
}) {
  return (
    <div className="grid gap-3 rounded-3xl border border-slate-900 bg-slate-950 p-4 text-slate-50 shadow-sm">
      <div>
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          <History className="h-3.5 w-3.5" />
          In-year check
        </div>
        <p className="mt-2 text-sm leading-snug text-slate-200">
          Ask whether the evidence behind this decision still holds. The check
          runs the current evidence base against the snapshot we took when you
          committed it.
        </p>
      </div>
      <button
        type="button"
        onClick={onRun}
        disabled={state.kind === 'pending'}
        className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-blue-500 px-4 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Compass className="h-3.5 w-3.5" />
        {state.kind === 'pending'
          ? 'Checking…'
          : 'What changed since I committed this?'}
      </button>
      {state.kind === 'error' ? (
        <p className="rounded-2xl border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-[12px] text-orange-100">
          In-year check failed: {state.message}
        </p>
      ) : null}
      {state.kind === 'loaded' ? (
        <InYearResult response={state.response} committedAt={committedAt} />
      ) : (
        <p className="text-[11px] text-slate-400">
          Committed {formatCommittedAt(committedAt)}.
        </p>
      )}
    </div>
  );
}

function InYearResult({
  response,
  committedAt,
}: {
  response: DecisionInYearResponse;
  committedAt: string;
}) {
  const { diff, snapshot_hashes, current_hashes, query_id, asset_key_encoded } =
    response;
  const added = diff.evidence_added.length;
  const changed = diff.evidence_changed.length;
  const invalidated = diff.evidence_invalidated.length;
  const allEmpty = added === 0 && changed === 0 && invalidated === 0;

  return (
    <div className="grid gap-3 rounded-2xl border border-white/15 bg-white/5 p-3 text-[12px] text-slate-100">
      {allEmpty ? (
        <p>
          No change in the evidence base since you committed this on{' '}
          {formatCommittedAt(committedAt)}.
        </p>
      ) : (
        <div className="grid gap-2">
          {added > 0 ? (
            <DiffLine
              tone="emerald"
              headline={`${added} new source${added === 1 ? '' : 's'} now back this decision`}
              items={diff.evidence_added}
            />
          ) : null}
          {changed > 0 ? (
            <p className="text-slate-200">
              {changed} supporting claim
              {changed === 1 ? '' : 's'} or scenarios have shifted since you
              committed this. (Coarse change-detection today — listed below for
              transparency.)
            </p>
          ) : null}
          {invalidated > 0 ? (
            <DiffLine
              tone="orange"
              headline={`${invalidated} source${invalidated === 1 ? '' : 's'} no longer back this decision`}
              items={diff.evidence_invalidated}
            />
          ) : null}
          {changed > 0 ? (
            <DiffLine
              tone="amber"
              headline="Shifted (claims_hash or spec-curve_hash differs)"
              items={diff.evidence_changed}
            />
          ) : null}
        </div>
      )}

      <details className="rounded-xl border border-white/10 bg-white/5 p-2 text-[11px] text-slate-200">
        <summary className="cursor-pointer font-semibold uppercase tracking-wider text-slate-300">
          Verifier detail (snapshot vs current)
        </summary>
        <div className="mt-2 grid gap-1 font-mono">
          <span>
            Evidence then: {short(snapshot_hashes.evidence_hash)} · now:{' '}
            {short(current_hashes.evidence_hash)}
          </span>
          <span>
            Claims then: {short(snapshot_hashes.claims_hash)} · now:{' '}
            {short(current_hashes.claims_hash)}
          </span>
          <span>
            Curve then: {short(snapshot_hashes.curve_hash)} · now:{' '}
            {short(current_hashes.curve_hash)}
          </span>
        </div>
      </details>

      <Link
        href={`/assets/${asset_key_encoded}`}
        className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-200 underline-offset-2 hover:underline"
      >
        Saved as in-year query{' '}
        <span className="font-mono">{query_id.slice(0, 12)}…</span>
        <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}

function DiffLine({
  tone,
  headline,
  items,
}: {
  tone: 'emerald' | 'orange' | 'amber';
  headline: string;
  items: string[];
}) {
  const toneClass =
    tone === 'emerald'
      ? 'text-emerald-200'
      : tone === 'orange'
        ? 'text-orange-200'
        : 'text-amber-200';
  return (
    <div className="grid gap-1">
      <p className={cn('text-[12px] font-semibold', toneClass)}>
        {headline}
        {items.length > 0 ? ':' : '.'}
      </p>
      {items.length > 0 ? (
        <ul className="grid gap-1 pl-3">
          {items.slice(0, 5).map((item) => (
            <li key={item} className="break-words text-[11px] text-slate-200">
              · {item}
            </li>
          ))}
          {items.length > 5 ? (
            <li className="text-[11px] text-slate-400">
              … and {items.length - 5} more
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────

function matchCounterfactuals(
  refs: string[],
  assets: AssetSummary[],
): CfRow[] {
  // Counterfactual asset keys are [counterfactual, <study_slug>, <cf_id>].
  // We match by trailing segment so we don't need to replicate the
  // server-side slugger.
  const byCfId = new Map<string, AssetSummary>();
  for (const asset of assets) {
    if (asset.kind !== 'counterfactual') continue;
    const last = asset.asset_key.at(-1);
    if (!last) continue;
    byCfId.set(last, asset);
  }
  return refs.map((cfId) => {
    const asset = byCfId.get(cfId);
    if (!asset) {
      return {
        cfId,
        assetKeyEncoded: null,
        prompt: null,
        variants: [],
        inputs: [],
        assumes: [],
        doesNotAssume: [],
        illustrative: null,
      };
    }
    const md = (asset.metadata ?? {}) as Record<string, unknown>;
    return {
      cfId,
      assetKeyEncoded: asset.asset_key_encoded,
      prompt: typeof md.prompt === 'string' ? md.prompt : null,
      variants: Array.isArray(md.variants) ? (md.variants as unknown[]) : [],
      inputs: Array.isArray(md.inputs) ? (md.inputs as unknown[]) : [],
      assumes: Array.isArray(md.assumes)
        ? (md.assumes as unknown[]).filter(
            (a): a is string => typeof a === 'string',
          )
        : [],
      doesNotAssume: Array.isArray(md.does_not_assume)
        ? (md.does_not_assume as unknown[]).filter(
            (a): a is string => typeof a === 'string',
          )
        : [],
      illustrative:
        typeof md.illustrative === 'boolean' ? (md.illustrative as boolean) : null,
    };
  });
}

type ParsedVariant = {
  title: string | null;
  directional: string | null;
  math: string | null;
};

function pickFirstVariant(variants: unknown[]): ParsedVariant | null {
  if (variants.length === 0) return null;
  const v = variants[0] as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return null;
  return {
    title: typeof v.title === 'string' ? v.title : null,
    directional: typeof v.directional === 'string' ? v.directional : null,
    math: typeof v.math === 'string' ? v.math : null,
  };
}

function renderInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const label = typeof obj.label === 'string' ? obj.label : '';
    const source = typeof obj.source === 'string' ? obj.source : '';
    return [label, source].filter(Boolean).join(' · ');
  }
  return String(input);
}

function isLikelyEncodedAssetKey(value: string): boolean {
  // Encoded asset keys are urlsafe base64 of a JSON list. They never
  // contain whitespace, slashes, or commas. Keep the heuristic strict so
  // we don't accidentally link to /evidence with a description string.
  return /^[A-Za-z0-9_-]{20,}$/.test(value);
}

function humaniseSlug(slug: string): string {
  return slug
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase());
}

// A "prompt slug" is the typed stress-test id from /growth-driver
// (e.g. flip-fragile-assumption, cut-ap-30). Loose heuristic: kebab-
// shaped, no whitespace, mostly lowercase, < 60 chars. Anything with
// spaces is already a sentence.
function isPromptSlug(value: string | null | undefined): boolean {
  if (!value) return false;
  if (value.length > 60) return false;
  return /^[a-z0-9][a-z0-9-]*$/.test(value);
}

// Map known stress-test prompt slugs to a planner-readable sentence
// suitable for a card heading. Falls through to the variant title or
// the originally-stored prompt sentence when no slug match exists.
const STRESS_TEST_HEADINGS: Record<string, string> = {
  'flip-fragile-assumption': 'If the fragile assumption is wrong',
  'cut-ap-30': 'If we cut A&P by 30%',
  'add-competitor-response': 'If a competitor steps up in our focus markets',
  'alternative-driver': 'If we backed a peer driver instead',
  'in-year-since-last-quarter': "What changed in-year since last quarter",
  'discount-vs-bundle': 'Discount vs bundle',
};

function humaniseCfTitle({
  variantTitle,
  promptSlug,
  fallback,
}: {
  variantTitle: string | null;
  promptSlug: string | null;
  fallback: string;
}): string {
  if (variantTitle && variantTitle.trim()) return variantTitle;
  if (promptSlug && STRESS_TEST_HEADINGS[promptSlug]) {
    return STRESS_TEST_HEADINGS[promptSlug];
  }
  if (promptSlug) return humaniseSlug(promptSlug);
  return fallback;
}

function findingIndexOf(findingId: string): string | undefined {
  // Simulation builds finding ids as `finding-<idx>`. Round-trip the
  // index out so the /research page can pre-select it.
  const m = findingId.match(/finding-(\d+)/);
  return m ? m[1] : undefined;
}

function formatCommittedAt(value: string | null | undefined): string {
  if (!value) return 'unknown date';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function short(value: string | null | undefined): string {
  if (!value) return 'none';
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

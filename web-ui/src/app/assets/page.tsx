'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  DatabaseZap,
  Filter,
  GitBranch,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FocusCard } from '@/components/study/study-shell';
import { cn } from '@/lib/utils';
import {
  wb,
  type AssetGraph,
  type AssetSummary,
  type AssetsListResponse,
  type SpecCurve,
} from '@/components/workbench/types';

// Filter chips mirror the backend ASSET_KINDS set in
// src/diageo_research/web/api.py (M7 / FR-AT-1). The legacy "source"
// and "evidence" chips have been dropped — they never matched any
// backend kind and silently filtered everything out.
const KIND_FILTERS = [
  'all',
  'declared',
  'cell',
  'persona',
  'turn',
  'tool_call',
  'citation',
  'claim',
  'growth_driver',
  'counterfactual',
  'decision',
  'in_year_query',
  'task',
] as const;

type KindFilter = (typeof KIND_FILTERS)[number];

const KIND_LABELS: Record<KindFilter, string> = {
  all: 'all',
  declared: 'declared',
  cell: 'cell',
  persona: 'persona',
  turn: 'turn',
  tool_call: 'tool call',
  citation: 'citation',
  claim: 'claim',
  growth_driver: 'growth driver',
  counterfactual: 'counterfactual',
  decision: 'decision',
  in_year_query: 'in-year query',
  task: 'task',
};

const SUMMARY_KINDS: ReadonlySet<string> = new Set([
  'growth_driver',
  'counterfactual',
  'decision',
  'in_year_query',
  'task',
]);

const KIND_FILTER_SET: ReadonlySet<string> = new Set(KIND_FILTERS);

function readKindFromParams(searchParams: { get: (key: string) => string | null }): KindFilter {
  const raw = searchParams.get('kind');
  if (raw && KIND_FILTER_SET.has(raw)) return raw as KindFilter;
  return 'all';
}

export default function AssetsPage() {
  return (
    <Suspense fallback={null}>
      <AssetsPageBody />
    </Suspense>
  );
}

function AssetsPageBody() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The chip group is fully URL-driven. Reading kind straight off
  // the search params (no mirrored state) means deep-links like
  // /assets?kind=decision activate the matching chip on first render
  // and back/forward keeps the page in sync without a sync effect.
  const kind = readKindFromParams(searchParams);

  const [assetState, setAssetState] = useState<{
    data: AssetsListResponse | null;
    error: string | null;
    loading: boolean;
  }>({ data: null, error: null, loading: true });
  const [graphState, setGraphState] = useState<{
    data: AssetGraph | null;
    error: string | null;
  }>({ data: null, error: null });
  const [query, setQuery] = useState('');

  // Lineage filter: when /assets is opened with ?cluster=N&study=…
  // (from the ConfidencePanel "See provenance trace" row) we narrow
  // the list to assets that touched any cell in that cluster. The
  // spec curve is the only place that maps cluster_id → cell.run_id,
  // so we fetch it lazily and derive the run_id set.
  const studyParam = searchParams.get('study');
  const clusterParam = searchParams.get('cluster');
  const clusterId = clusterParam != null ? Number(clusterParam) : null;
  const clusterActive =
    Boolean(studyParam) && clusterId != null && Number.isFinite(clusterId);
  const [clusterCurve, setClusterCurve] = useState<{
    studyId: string;
    curve: SpecCurve | null;
  } | null>(null);

  useEffect(() => {
    if (!clusterActive || !studyParam) return;
    let cancelled = false;
    wb.specCurve(studyParam)
      .then((curve) => {
        if (!cancelled) setClusterCurve({ studyId: studyParam, curve });
      })
      .catch(() => {
        if (!cancelled) setClusterCurve({ studyId: studyParam, curve: null });
      });
    return () => {
      cancelled = true;
    };
  }, [studyParam, clusterActive]);

  const clusterRunIds = useMemo<Set<string> | null>(() => {
    if (!clusterActive) return null;
    if (!clusterCurve?.curve) return new Set();
    const row = clusterCurve.curve.rows.find(
      (r) => r.cluster_id === clusterId,
    );
    if (!row) return new Set();
    const ids = new Set<string>();
    const cellById = new Map(clusterCurve.curve.cells.map((c) => [c.id, c]));
    for (const [cellId, status] of Object.entries(row.statuses)) {
      if (status === 'missing') continue;
      const cell = cellById.get(cellId);
      if (cell?.run_id) ids.add(cell.run_id);
    }
    return ids;
  }, [clusterActive, clusterCurve, clusterId]);

  const clusterTitle = useMemo<string | null>(() => {
    if (!clusterCurve?.curve || clusterId == null) return null;
    const row = clusterCurve.curve.rows.find(
      (r) => r.cluster_id === clusterId,
    );
    if (!row) return null;
    return row.representative.split(/(?<=[.!?])\s+/)[0]?.slice(0, 96) ?? null;
  }, [clusterCurve, clusterId]);

  const onClearCluster = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('cluster');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [pathname, router, searchParams]);

  const setKindAndUrl = useCallback(
    (next: KindFilter) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'all') {
        params.delete('kind');
      } else {
        params.set('kind', next);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, router, searchParams],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([wb.assets(), wb.assetGraph()]).then(([assets, graph]) => {
      if (cancelled) return;
      if (assets.status === 'fulfilled') {
        setAssetState({ data: assets.value, error: null, loading: false });
      } else {
        setAssetState({
          data: null,
          error: errorMessage(assets.reason),
          loading: false,
        });
      }
      if (graph.status === 'fulfilled') {
        setGraphState({ data: graph.value, error: null });
      } else {
        setGraphState({ data: null, error: errorMessage(graph.reason) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const downstreamCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of graphState.data?.edges ?? []) {
      counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
    }
    return counts;
  }, [graphState.data]);

  // Map decision_id → number of in_year_query assets that bind to it,
  // so the decision summary card can carry a "tested in-year N times"
  // badge (FR-AT-2). Cheap because /assets returns metadata inline.
  const inYearByDecision = useMemo(() => {
    const counts = new Map<string, number>();
    for (const asset of assetState.data?.assets ?? []) {
      if (asset.kind !== 'in_year_query') continue;
      const md = asset.metadata ?? {};
      const boundTo = typeof md.bound_to === 'string' ? md.bound_to : '';
      if (!boundTo) continue;
      counts.set(boundTo, (counts.get(boundTo) ?? 0) + 1);
    }
    return counts;
  }, [assetState.data]);

  const filteredAssets = useMemo(() => {
    const assets = assetState.data?.assets ?? [];
    const needle = query.trim().toLowerCase();
    return assets.filter((asset) => {
      const assetKind = assetKindLabel(asset).toLowerCase();
      if (kind !== 'all' && assetKind !== kind) return false;
      if (clusterRunIds != null) {
        const md = asset.metadata ?? {};
        const mdCluster =
          typeof md.cluster_id === 'number'
            ? md.cluster_id
            : typeof md.cluster_id === 'string'
              ? Number(md.cluster_id)
              : null;
        const runMatch = asset.run_id ? clusterRunIds.has(asset.run_id) : false;
        const clusterMatch = mdCluster != null && mdCluster === clusterId;
        if (!runMatch && !clusterMatch) return false;
      }
      if (!needle) return true;
      const haystack = [
        assetName(asset),
        asset.asset_key.join('/'),
        asset.partition_key ?? '',
        asset.run_id ?? '',
        assetKind,
        String(asset.metadata.question_hash ?? ''),
        String(asset.metadata.axes_signature ?? ''),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [assetState.data, kind, query, clusterRunIds, clusterId]);

  // Total before the cluster filter so the pill can read "N of M".
  const totalForCounts = useMemo(() => {
    const assets = assetState.data?.assets ?? [];
    return assets.filter((asset) => {
      const assetKind = assetKindLabel(asset).toLowerCase();
      if (kind !== 'all' && assetKind !== kind) return false;
      return true;
    }).length;
  }, [assetState.data, kind]);

  return (
    <main className="min-h-svh bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.10),transparent_32rem),linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)] px-4 py-8 font-sans text-slate-950 sm:px-6">
      <div className="mx-auto grid w-full max-w-6xl gap-5">
        <header className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div className="grid gap-2">
            <Badge
              variant="outline"
              className="w-fit border-blue-200 bg-blue-50 text-[10px] font-semibold uppercase tracking-[0.2em] text-blue-700"
            >
              Evidence / asset explorer
            </Badge>
            <h1 className="max-w-3xl text-balance text-3xl font-semibold tracking-tight text-slate-950">
              Every reusable piece of evidence behind a recommendation.
            </h1>
            <p className="max-w-3xl text-sm leading-relaxed text-slate-600">
              Each card is one reusable piece of evidence or pipeline
              output. Open it to validate provenance, review the readable
              receipt, re-run it when allowed, or trace what would change
              downstream.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="rounded-full border-slate-200 bg-white shadow-sm"
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </header>

        <ReuseMapPanel
          graph={graphState.data}
          error={graphState.error}
          downstreamCounts={downstreamCounts}
        />

        {clusterRunIds != null ? (
          <ClusterScopePill
            clusterId={clusterId ?? 0}
            title={clusterTitle}
            visible={filteredAssets.length}
            total={totalForCounts}
            onClear={onClearCluster}
          />
        ) : null}

        <FocusCard className="grid gap-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name, dimensions, run, or question — plain words work too"
                className="h-10 w-full rounded-full border border-slate-200 bg-white pl-9 pr-4 text-sm shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-slate-400"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                <Filter className="h-3 w-3" />
                Filter
              </span>
              {KIND_FILTERS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setKindAndUrl(item)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-[12px] font-medium capitalize transition-colors',
                    kind === item
                      ? 'border-slate-900 bg-slate-950 text-white'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900',
                  )}
                >
                  {KIND_LABELS[item]}
                </button>
              ))}
            </div>
          </div>

          {assetState.loading ? (
            <AssetSkeleton />
          ) : assetState.error ? (
            <ErrorBox message={assetState.error} />
          ) : filteredAssets.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/80 p-5 text-sm text-slate-500">
              No evidence assets match this search. Try clearing the
              filter or run a study first.
            </div>
          ) : (
            <section className="grid gap-3 md:grid-cols-2">
              {filteredAssets.map((asset) => {
                const summaryKind = SUMMARY_KINDS.has(assetKindLabel(asset))
                  ? (assetKindLabel(asset) as SummaryKind)
                  : null;
                if (summaryKind) {
                  return (
                    <SummaryCard
                      key={`${asset.asset_key_encoded}-${asset.partition_key ?? 'none'}`}
                      asset={asset}
                      kind={summaryKind}
                      inYearCount={
                        summaryKind === 'decision'
                          ? (inYearByDecision.get(
                              decisionIdOf(asset) ?? '',
                            ) ?? 0)
                          : 0
                      }
                    />
                  );
                }
                return (
                  <AssetCard
                    key={`${asset.asset_key_encoded}-${asset.partition_key ?? 'none'}`}
                    asset={asset}
                    downstreamCount={downstreamCounts.get(assetName(asset)) ?? 0}
                  />
                );
              })}
            </section>
          )}
        </FocusCard>
      </div>
    </main>
  );
}

function ClusterScopePill({
  clusterId,
  title,
  visible,
  total,
  onClear,
}: {
  clusterId: number;
  title: string | null;
  visible: number;
  total: number;
  onClear: () => void;
}) {
  return (
    <div className="sticky top-2 z-10 rounded-2xl border border-amber-200 bg-amber-50/90 px-3 py-2 text-[12px] text-amber-900 shadow-sm backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="leading-snug">
          Showing provenance for{' '}
          <span className="font-semibold">
            cluster {clusterId}
            {title ? `: "${title}"` : ''}
          </span>{' '}
          — <span className="font-mono">{visible}</span> of{' '}
          <span className="font-mono">{total}</span> assets
        </p>
        <button
          type="button"
          onClick={onClear}
          className="rounded-full border border-amber-300 bg-white px-3 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
        >
          Show all
        </button>
      </div>
    </div>
  );
}

type SummaryKind =
  | 'growth_driver'
  | 'counterfactual'
  | 'decision'
  | 'in_year_query'
  | 'task';

function SummaryCard({
  asset,
  kind,
  inYearCount,
}: {
  asset: AssetSummary;
  kind: SummaryKind;
  inYearCount: number;
}) {
  const md = (asset.metadata ?? {}) as Record<string, unknown>;
  const content = (() => {
    switch (kind) {
      case 'growth_driver':
        return renderGrowthDriverSummary(md);
      case 'counterfactual':
        return renderCounterfactualSummary(md);
      case 'decision':
        return renderDecisionSummary(md, inYearCount);
      case 'in_year_query':
        return renderInYearSummary(md);
      case 'task':
        return renderTaskSummary(md);
    }
  })();
  return (
    <article className="group grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-950/[0.03] transition-all hover:-translate-y-0.5 hover:border-slate-300">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 text-sm font-semibold leading-snug tracking-tight text-slate-950">
            {content.title}
          </h2>
          {content.subtitle ? (
            <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-slate-600">
              {content.subtitle}
            </p>
          ) : null}
        </div>
        <KindBadge kind={KIND_LABELS[kind as KindFilter] ?? kind} />
      </div>
      {content.facts.length > 0 ? (
        <ul className="grid gap-1 text-[12px] text-slate-700">
          {content.facts.map((fact) => (
            <li key={fact.label} className="flex items-baseline gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                {fact.label}
              </span>
              <span className="truncate font-medium text-slate-800">
                {fact.value}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {content.badges.map((badge) => (
          <Badge
            key={badge.label}
            variant="outline"
            className={cn(
              'border text-[10px] font-medium',
              badge.tone === 'amber'
                ? 'border-amber-200 bg-amber-50 text-amber-700'
                : badge.tone === 'emerald'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : badge.tone === 'orange'
                    ? 'border-orange-200 bg-orange-50 text-orange-700'
                    : 'border-slate-200 bg-slate-50 text-slate-600',
            )}
          >
            {badge.label}
          </Badge>
        ))}
      </div>
      <Link
        href={`/assets/${asset.asset_key_encoded}`}
        className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-slate-950 px-4 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
      >
        Open
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </article>
  );
}

type SummaryFact = { label: string; value: string };
type SummaryBadge = {
  label: string;
  tone: 'slate' | 'amber' | 'emerald' | 'orange';
};
type SummaryContent = {
  title: string;
  subtitle: string | null;
  facts: SummaryFact[];
  badges: SummaryBadge[];
};

function renderGrowthDriverSummary(
  md: Record<string, unknown>,
): SummaryContent {
  const driverName = stringField(md.driver_name) || 'Growth driver';
  const mustDo = stringField(md.must_do_title) || stringField(md.must_do);
  const confidence = stringField(md.confidence_pill);
  const illustrative = md.illustrative === true;
  const badges: SummaryBadge[] = [];
  if (confidence) badges.push({ label: confidence, tone: 'slate' });
  if (illustrative) badges.push({ label: 'Illustrative', tone: 'amber' });
  return {
    title: driverName,
    subtitle: mustDo ? `Must-Do · ${mustDo}` : null,
    facts: [],
    badges,
  };
}

function renderCounterfactualSummary(
  md: Record<string, unknown>,
): SummaryContent {
  const prompt = stringField(md.prompt) || 'Counterfactual scenario';
  const variants = Array.isArray(md.variants) ? md.variants.length : 0;
  const scope = (md.scope ?? {}) as Record<string, unknown>;
  const driverId = stringField(scope.driver_id);
  const findingId = stringField(scope.finding_id);
  const subtitle = driverId
    ? `for driver ${humaniseSlug(driverId)}`
    : findingId
      ? `for finding ${humaniseSlug(findingId)}`
      : null;
  return {
    title: prompt,
    subtitle,
    facts: [
      { label: 'Variants', value: String(variants) },
      { label: 'Study', value: stringField(scope.study_id) || '—' },
    ],
    badges: [],
  };
}

function renderDecisionSummary(
  md: Record<string, unknown>,
  inYearCount: number,
): SummaryContent {
  const recommendation =
    stringField(md.recommendation) || 'Committed decision';
  const committedAt = stringField(md.committed_at);
  const scope = (md.scope ?? {}) as Record<string, unknown>;
  const driverId = stringField(scope.driver_id);
  const findingId = stringField(scope.finding_id);
  const scopeLabel = driverId
    ? humaniseSlug(driverId)
    : findingId
      ? humaniseSlug(findingId)
      : stringField(scope.study_id) || '—';
  const owner = stringField(md.owner);
  const facts: SummaryFact[] = [
    { label: 'Scope', value: scopeLabel },
    { label: 'Committed', value: formatTimestamp(committedAt) },
  ];
  if (owner) facts.push({ label: 'Owner', value: owner });
  const badges: SummaryBadge[] = [];
  if (inYearCount > 0) {
    badges.push({
      label: `tested in-year ${inYearCount} time${inYearCount === 1 ? '' : 's'}`,
      tone: 'emerald',
    });
  }
  return {
    title: recommendation,
    subtitle: null,
    facts,
    badges,
  };
}

function renderInYearSummary(md: Record<string, unknown>): SummaryContent {
  const boundTo = stringField(md.bound_to);
  const askedAt = stringField(md.asked_at);
  const diff = (md.diff ?? {}) as Record<string, unknown>;
  const added = Array.isArray(diff.evidence_added)
    ? diff.evidence_added.length
    : 0;
  const invalidated = Array.isArray(diff.evidence_invalidated)
    ? diff.evidence_invalidated.length
    : 0;
  const changed = Array.isArray(diff.evidence_changed)
    ? diff.evidence_changed.length
    : 0;
  return {
    title: boundTo
      ? `In-year query for decision ${boundTo.slice(0, 12)}…`
      : 'In-year query',
    subtitle: `${added} added · ${invalidated} invalidated · ${changed} shifted`,
    facts: [{ label: 'Asked', value: formatTimestamp(askedAt) }],
    badges:
      added + invalidated + changed === 0
        ? [{ label: 'no evidence change', tone: 'slate' }]
        : [],
  };
}

function renderTaskSummary(md: Record<string, unknown>): SummaryContent {
  const taskKind = stringField(md.task_kind) || stringField(md.kind) || 'task';
  const status = stringField(md.status) || 'open';
  const due = stringField(md.due_date) || 'no due date';
  const scope = (md.scope ?? {}) as Record<string, unknown>;
  const driverId = stringField(scope.driver_id);
  const findingId = stringField(scope.finding_id);
  const scopeLabel = driverId
    ? humaniseSlug(driverId)
    : findingId
      ? humaniseSlug(findingId)
      : stringField(scope.study_id) || '—';
  const tone: SummaryBadge['tone'] =
    status === 'done' ? 'emerald' : status === 'in_progress' ? 'slate' : 'amber';
  return {
    title: stringField(md.description) || `Task — ${humaniseSlug(taskKind)}`,
    subtitle: `kind · ${humaniseSlug(taskKind)}`,
    facts: [
      { label: 'Scope', value: scopeLabel },
      { label: 'Due', value: due },
    ],
    badges: [{ label: status, tone }],
  };
}

function decisionIdOf(asset: AssetSummary): string | undefined {
  if (asset.kind !== 'decision') return undefined;
  const md = asset.metadata ?? {};
  const fromMd = typeof md.decision_id === 'string' ? md.decision_id : null;
  if (fromMd) return fromMd;
  return asset.asset_key.at(-1) ?? undefined;
}

function humaniseSlug(slug: string): string {
  if (!slug) return slug;
  return slug
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase());
}

function stringField(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

function AssetCard({
  asset,
  downstreamCount,
}: {
  asset: AssetSummary;
  downstreamCount: number;
}) {
  const status = latestStatus(asset);
  return (
    <article className="group grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-950/[0.03] transition-all hover:-translate-y-0.5 hover:border-slate-300">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-950 text-white shadow-sm">
          <DatabaseZap className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold tracking-tight text-slate-950">
            {humaniseAssetName(asset)}
          </h2>
          <p
            className="mt-0.5 truncate font-mono text-[11px] text-slate-500"
            title={asset.asset_key.join(' / ')}
          >
            {asset.asset_key.join(' / ')}
          </p>
        </div>
        <KindBadge kind={assetKindLabel(asset)} />
      </div>

      <div className="grid grid-cols-2 gap-2 text-[12px]">
        <MiniMetric label="Latest status" value={status} />
        <MiniMetric label="Last materialized" value={formatTimestamp(asset.timestamp)} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {provenanceBadges(asset).map((badge) => (
          <Badge
            key={badge}
            variant="outline"
            className="border-slate-200 bg-slate-50 text-[10px] font-medium text-slate-600"
          >
            {badge}
          </Badge>
        ))}
        {downstreamCount > 0 ? (
          <Badge
            variant="outline"
            className="border-violet-200 bg-violet-50 text-[10px] font-medium text-violet-700"
          >
            affects {downstreamCount} downstream
          </Badge>
        ) : null}
      </div>

      <Link
        href={`/assets/${asset.asset_key_encoded}`}
        className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-slate-950 px-4 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
      >
        Review
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </article>
  );
}

function ReuseMapPanel({
  graph,
  error,
  downstreamCounts,
}: {
  graph: AssetGraph | null;
  error: string | null;
  downstreamCounts: Map<string, number>;
}) {
  const rows = useMemo(() => {
    return (graph?.nodes ?? [])
      .map((node) => ({
        node,
        count: downstreamCounts.get(node.id) ?? 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [downstreamCounts, graph]);

  return (
    <FocusCard tone="muted" className="grid gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-violet-600" />
            <h2 className="text-sm font-semibold tracking-tight text-slate-950">
              Reuse map
            </h2>
          </div>
          <p className="mt-1 max-w-3xl text-[13px] leading-snug text-slate-600">
            Re-materializing an evidence / asset can change every downstream
            output that reuses it. This map highlights the declared pipeline
            pieces with the widest downstream effect.
          </p>
        </div>
        {graph ? (
          <Badge
            variant="outline"
            className="border-violet-200 bg-white text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-700"
          >
            {graph.nodes.length} assets · {graph.edges.length} links
          </Badge>
        ) : null}
      </div>

      {error ? (
        <ErrorBox message={`Reuse map unavailable: ${error}`} />
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 p-4 text-sm text-slate-500">
          Downstream data is sparse right now. Once more declared assets have
          lineage, this panel will show who would be affected before a re-run.
        </div>
      ) : (
        <div className="grid gap-2 md:grid-cols-3">
          {rows.map(({ node, count }) => (
            <div
              key={node.id}
              className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
                  {node.label || node.id}
                </span>
                <Badge
                  variant="outline"
                  className="border-slate-200 bg-slate-50 text-[10px] text-slate-600"
                >
                  {count} downstream
                </Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-slate-500">
                {node.description || 'Reusable evidence asset.'}
              </p>
            </div>
          ))}
        </div>
      )}
    </FocusCard>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        {label}
      </div>
      <div className="mt-1 truncate font-medium text-slate-800">{value}</div>
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <Badge
      variant="outline"
      className="shrink-0 border-blue-200 bg-blue-50 text-[10px] font-semibold uppercase tracking-[0.16em] text-blue-700"
    >
      {kind}
    </Badge>
  );
}

function AssetSkeleton() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="h-44 animate-pulse rounded-2xl border border-slate-200 bg-slate-100"
        />
      ))}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-700">
      {message}
    </div>
  );
}

function assetName(asset: AssetSummary) {
  return asset.asset_key.at(-1) ?? asset.asset_key.join('/');
}

function humaniseAssetName(asset: AssetSummary) {
  const last = assetName(asset);
  if (!last) return 'Evidence asset';
  const stem = last
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!stem) return last;
  return stem
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function assetKindLabel(asset: AssetSummary) {
  const metadataKind = valueAsString(asset.metadata.kind);
  return metadataKind || asset.kind || inferKind(asset);
}

function inferKind(asset: AssetSummary) {
  if (asset.asset_key[0] === 'research_cell') return 'cell';
  return 'declared';
}

function latestStatus(asset: AssetSummary) {
  return valueAsString(asset.metadata.status) || (asset.timestamp ? 'materialized' : 'not run');
}

function provenanceBadges(asset: AssetSummary) {
  const md = asset.metadata;
  const badges: string[] = [];
  if (md.code_version) badges.push(`code ${String(md.code_version).slice(0, 8)}`);
  if (md.prompt_version) badges.push(`prompt ${String(md.prompt_version).slice(0, 8)}`);
  if (md.input_hash || md.output_hash) badges.push('hashes recorded');
  if (md.provenance || md.materialization_path) badges.push('provenance');
  if (md.verified != null) badges.push(`${String(md.verified)} verified`);
  if (md.question_hash) badges.push(`question ${String(md.question_hash).slice(0, 8)}`);
  return badges.length > 0 ? badges.slice(0, 4) : ['metadata pending'];
}

function valueAsString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function formatTimestamp(value: AssetSummary['timestamp']) {
  if (value == null || value === 0 || value === '') return 'not yet';
  const date =
    typeof value === 'number' ? new Date(value * 1000) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

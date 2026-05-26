'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
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
} from '@/components/workbench/types';

const KIND_FILTERS = ['all', 'declared', 'cell', 'source', 'evidence'] as const;

type KindFilter = (typeof KIND_FILTERS)[number];

export default function AssetsPage() {
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
  const [kind, setKind] = useState<KindFilter>('all');

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

  const filteredAssets = useMemo(() => {
    const assets = assetState.data?.assets ?? [];
    const needle = query.trim().toLowerCase();
    return assets.filter((asset) => {
      const assetKind = assetKindLabel(asset).toLowerCase();
      if (kind !== 'all' && assetKind !== kind) return false;
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
  }, [assetState.data, kind, query]);

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
              Validate, review, trigger, and trace evidence assets.
            </h1>
            <p className="max-w-3xl text-sm leading-relaxed text-slate-600">
              Each card is one reusable piece of evidence or pipeline output.
              Open it to check provenance, inspect produced paths, re-run eligible
              research cells, and see what downstream work would be affected.
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

        <FocusCard className="grid gap-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by asset name, key, run, question hash, or axes"
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
                  onClick={() => setKind(item)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-[12px] font-medium capitalize transition-colors',
                    kind === item
                      ? 'border-slate-900 bg-slate-950 text-white'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900',
                  )}
                >
                  {item}
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
              No assets match this search. Try clearing the filter or materialize
              a study first.
            </div>
          ) : (
            <section className="grid gap-3 md:grid-cols-2">
              {filteredAssets.map((asset) => (
                <AssetCard
                  key={`${asset.asset_key_encoded}-${asset.partition_key ?? 'none'}`}
                  asset={asset}
                  downstreamCount={downstreamCounts.get(assetName(asset)) ?? 0}
                />
              ))}
            </section>
          )}
        </FocusCard>
      </div>
    </main>
  );
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
            {assetName(asset)}
          </h2>
          <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
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

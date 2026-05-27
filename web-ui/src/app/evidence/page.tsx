'use client';

/**
 * /evidence — claims list page.
 *
 * Each row in the page is one claim cluster from the spec curve, not a
 * flat paraphrase of the brief. For every claim we show:
 *
 *   - the short claim title (first declarative sentence of the
 *     cluster's representative recommendation, citation markers
 *     stripped);
 *   - a one-line summary metric — "3 web docs · 2 SQL results" — taken
 *     from the lead source cell's ``final.json`` citations;
 *   - a plain-language confidence pill ("3 of 4 scenarios agree", not
 *     "100%");
 *   - a "Trace this claim" CTA.
 *
 * Search + filter controls let stakeholders narrow by claim text,
 * source kind, or scenario dimension. Sorting follows the spec curve
 * (robustness desc, then n_agree+n_weaker desc) so the lead cluster —
 * the one used as the synthesis hero — is always first.
 */

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Search, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { cn } from '@/lib/utils';
import {
  wb,
  type CellSummary,
  type RunCitation,
  type SpecCurveRow,
} from '@/components/workbench/types';
import {
  agreementToneClass,
  citationKind,
  extractClaimTitle,
  formatSourceSummary,
  summarizeAgreement,
  summarizeCitations,
  type SourceKind,
  type SourceSummary,
} from '@/components/evidence/claim-utils';

type ClaimSourceState = {
  loading: boolean;
  citations: RunCitation[];
  summary: SourceSummary;
  runId: string | null;
  error: string | null;
};

const EMPTY_SUMMARY: SourceSummary = { web: 0, sql: 0, doc: 0, total: 0 };

export default function EvidenceIndexPage() {
  const data = useStudyData();
  const { curve, loadingCurve, studyId } = data;

  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<SourceKind | 'all'>('all');
  const [scenarioFilter, setScenarioFilter] = useState<string>('all');

  const cells = useMemo(() => curve?.cells ?? [], [curve]);
  const rows: SpecCurveRow[] = useMemo(() => curve?.rows ?? [], [curve]);

  // Find the lead source cell per cluster — the highest-evidence agree
  // cell, fall back to any cell with a status. Mirrors what the detail
  // page does so the summary metric and the detail page agree.
  const leadCellByCluster = useMemo(() => {
    const out = new Map<number, CellSummary | null>();
    for (const row of rows) {
      const agreeing = cells.filter((c) => row.statuses[c.id] === 'agree');
      const lead =
        agreeing[0] ?? cells.find((c) => row.statuses[c.id]) ?? null;
      out.set(row.cluster_id, lead);
    }
    return out;
  }, [rows, cells]);

  // Lazy-fetch final.json for each lead cell so we can show "X sources"
  // counts in the list without forcing a detail-page navigation. Keyed
  // by run_id so cells shared across clusters only fetch once. The
  // ``in-flight`` ref makes the effect idempotent without writing to
  // React state synchronously inside the effect body.
  const [sources, setSources] = useState<Record<string, ClaimSourceState>>(
    {},
  );
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!studyId) return;
    const runIds = new Set<string>();
    leadCellByCluster.forEach((cell) => {
      if (cell) runIds.add(cell.run_id);
    });
    let cancelled = false;
    const inFlight = inFlightRef.current;
    for (const runId of runIds) {
      if (sources[runId] || inFlight.has(runId)) continue;
      inFlight.add(runId);
      wb.runFinal(runId)
        .then((res) => {
          if (cancelled) return;
          const cites = res.json?.citations ?? [];
          setSources((s) => ({
            ...s,
            [runId]: {
              loading: false,
              citations: cites,
              summary: summarizeCitations(cites),
              runId,
              error: null,
            },
          }));
        })
        .catch((err) => {
          if (cancelled) return;
          setSources((s) => ({
            ...s,
            [runId]: {
              loading: false,
              citations: [],
              summary: EMPTY_SUMMARY,
              runId,
              error: err instanceof Error ? err.message : String(err),
            },
          }));
        })
        .finally(() => {
          inFlight.delete(runId);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [studyId, leadCellByCluster, sources]);

  // Build the scenario filter options from the cells' dimensions.
  // ``lens: solo`` is the multiverse's "no real dimensions" sentinel; we
  // hide it from the filter pill row so a single-scenario study doesn't
  // get a meaningless "Scenario · lens: solo" pill.
  const scenarioOptions = useMemo(() => {
    const out = new Set<string>();
    for (const cell of cells) {
      for (const [dimension, value] of Object.entries(cell.axes)) {
        if (dimension === 'lens' && value === 'solo') continue;
        out.add(`${dimension}:${value}`);
      }
    }
    return Array.from(out).sort();
  }, [cells]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (q) {
        const haystack = row.representative.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (kindFilter !== 'all') {
        const lead = leadCellByCluster.get(row.cluster_id);
        const cites = lead ? sources[lead.run_id]?.citations ?? [] : [];
        const hasKind = cites.some((c) => citationKind(c) === kindFilter);
        if (!hasKind) return false;
      }
      if (scenarioFilter !== 'all') {
        const [dim, val] = scenarioFilter.split(':');
        // Keep rows where at least one cell whose dimension+value match
        // is part of the cluster's statuses (any non-missing vote).
        const matchingCells = cells.filter(
          (c) => c.axes[dim] === val && row.statuses[c.id],
        );
        if (matchingCells.length === 0) return false;
      }
      return true;
    });
  }, [
    rows,
    search,
    kindFilter,
    scenarioFilter,
    leadCellByCluster,
    sources,
    cells,
  ]);

  return (
    <StudyShell
      data={data}
      eyebrow="Evidence"
      title="Pick a claim to verify."
      intro="Every claim links back to the sources that produced it and the scenarios that tested it."
    >
      {!studyId ? null : loadingCurve || !curve ? (
        <FocusCard tone="muted">
          <div className="grid gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded-2xl bg-slate-200/70"
              />
            ))}
          </div>
        </FocusCard>
      ) : rows.length === 0 ? (
        <FocusCard>
          <p className="text-sm text-slate-600">
            No clustered claims yet — the briefs haven&apos;t produced
            recommendation-shaped sentences.
          </p>
        </FocusCard>
      ) : (
        <>
          <FilterBar
            search={search}
            onSearch={setSearch}
            kindFilter={kindFilter}
            onKindFilter={setKindFilter}
            scenarioFilter={scenarioFilter}
            onScenarioFilter={setScenarioFilter}
            scenarioOptions={scenarioOptions}
            visible={visibleRows.length}
            total={rows.length}
          />

          {visibleRows.length === 0 ? (
            <FocusCard>
              <p className="text-sm text-slate-600">
                No claims match the current filters. Clear them or widen
                the search.
              </p>
            </FocusCard>
          ) : (
            <FocusCard>
              <ul className="grid gap-2">
                {visibleRows.map((row, idx) => {
                  const lead = leadCellByCluster.get(row.cluster_id) ?? null;
                  const src = lead ? sources[lead.run_id] : undefined;
                  return (
                    <ClaimRow
                      key={row.cluster_id}
                      row={row}
                      studyId={studyId}
                      isLead={idx === 0 && !search && kindFilter === 'all' && scenarioFilter === 'all'}
                      source={src}
                    />
                  );
                })}
              </ul>
            </FocusCard>
          )}
        </>
      )}
    </StudyShell>
  );
}

function FilterBar({
  search,
  onSearch,
  kindFilter,
  onKindFilter,
  scenarioFilter,
  onScenarioFilter,
  scenarioOptions,
  visible,
  total,
}: {
  search: string;
  onSearch: (v: string) => void;
  kindFilter: SourceKind | 'all';
  onKindFilter: (v: SourceKind | 'all') => void;
  scenarioFilter: string;
  onScenarioFilter: (v: string) => void;
  scenarioOptions: string[];
  visible: number;
  total: number;
}) {
  return (
    <FocusCard className="p-4 sm:p-4">
      <div className="grid gap-3">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 shadow-inner">
          <Search className="h-3.5 w-3.5 text-slate-400" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search claim text…"
            className="w-full border-0 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
          <span className="font-semibold uppercase tracking-[0.16em] text-slate-500">
            Source kind
          </span>
          <FilterPill
            label="All"
            active={kindFilter === 'all'}
            onClick={() => onKindFilter('all')}
          />
          <FilterPill
            label="Web"
            active={kindFilter === 'web'}
            onClick={() => onKindFilter('web')}
          />
          <FilterPill
            label="SQL"
            active={kindFilter === 'sql'}
            onClick={() => onKindFilter('sql')}
          />
          <FilterPill
            label="Internal docs"
            active={kindFilter === 'doc'}
            onClick={() => onKindFilter('doc')}
          />
        </div>
        {scenarioOptions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
            <span className="font-semibold uppercase tracking-[0.16em] text-slate-500">
              Scenario
            </span>
            <FilterPill
              label="Any"
              active={scenarioFilter === 'all'}
              onClick={() => onScenarioFilter('all')}
            />
            {scenarioOptions.map((opt) => {
              const [dim, val] = opt.split(':');
              return (
                <FilterPill
                  key={opt}
                  label={`${dim}: ${val}`}
                  active={scenarioFilter === opt}
                  onClick={() => onScenarioFilter(opt)}
                />
              );
            })}
          </div>
        ) : null}
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <span>
            Showing {visible} of {total} claims
          </span>
          <span className="text-slate-300">·</span>
          <span>Lead claim first, then by support.</span>
        </div>
      </div>
    </FocusCard>
  );
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
        active
          ? 'border-slate-900 bg-slate-900 text-white'
          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
      )}
    >
      {label}
    </button>
  );
}

function ClaimRow({
  row,
  studyId,
  isLead,
  source,
}: {
  row: SpecCurveRow;
  studyId: string | null;
  isLead: boolean;
  source: ClaimSourceState | undefined;
}) {
  const title = useMemo(() => extractClaimTitle(row.representative), [row]);
  const agree = useMemo(() => summarizeAgreement(row), [row]);
  const summary = source?.summary ?? EMPTY_SUMMARY;
  const loadingSources = source?.loading ?? true;
  const hasError = Boolean(source?.error);

  return (
    <li>
      <Link
        href={withStudy(`/evidence/${row.cluster_id}`, studyId)}
        className="group grid gap-3 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-slate-400 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
      >
        <div className="min-w-0 grid gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {isLead ? (
              <Badge
                variant="outline"
                className="gap-1 border-blue-200 bg-blue-50 text-[10px] uppercase tracking-wider text-blue-700"
              >
                <Sparkles className="h-3 w-3" />
                Lead claim
              </Badge>
            ) : null}
            <span
              className={cn(
                'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]',
                agreementToneClass(agree.tone),
              )}
            >
              {agree.text}
            </span>
          </div>
          <h3 className="text-[14px] font-semibold leading-snug text-slate-900 group-hover:text-slate-950">
            {title}
          </h3>
          <p className="text-[12px] leading-snug text-slate-600">
            {hasError
              ? 'Sources unavailable for this claim.'
              : loadingSources
                ? 'Counting cited sources…'
                : formatSourceSummary(summary)}
          </p>
        </div>
        <div className="flex items-center gap-2 self-end text-[12px] font-medium text-slate-700 sm:self-center">
          Trace this claim
          <ArrowRight className="h-3.5 w-3.5 text-slate-400 transition-colors group-hover:text-slate-700" />
        </div>
      </Link>
    </li>
  );
}

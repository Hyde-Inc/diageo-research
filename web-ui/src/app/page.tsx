'use client';

/**
 * Home — grouped explorer.
 *
 * Four sections (top to bottom), each with a small section header + a
 * count chip. A single free-text filter at the top searches across all
 * four sections. "Start a new study" pins top-right. The old tile
 * shortcuts get demoted to a small footer block.
 *
 *   1. Planning contexts (MBPs) — currently the Crown Royal × NFL MBP,
 *      hydrated from GET /studies/{study_31c6667a40}/growth-drivers.
 *   2. Studies — every research study on disk.
 *   3. Committed decisions — GET /assets?kind=decision.
 *   4. In-year queries — GET /assets?kind=in_year_query.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  FlaskConical,
  PencilLine,
  Search,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  wb,
  type AssetSummary,
  type GrowthDriversResponse,
  type StudySummary,
} from '@/components/workbench/types';
import { humaniseName } from '@/components/global-nav';

// One seeded MBP for now. When the backend grows a real index of
// planning contexts, this becomes a list fetch.
const SEEDED_MBP = {
  studyId: 'study_31c6667a40',
  brand: 'Crown Royal',
  mbpLabel: 'Crown Royal × NFL 2026-27 MBP',
  cycleWindow: 'Q3 2026 → Q2 2027',
};

type MbpRow = {
  studyId: string;
  brand: string;
  mbpLabel: string;
  cycleWindow: string;
  mustDoCount: number;
  driverCount: number;
  confidence: string | null;
};

export default function HomePage() {
  const [studies, setStudies] = useState<StudySummary[]>([]);
  const [studiesError, setStudiesError] = useState<string | null>(null);
  const [mbp, setMbp] = useState<MbpRow | null>(null);
  const [decisions, setDecisions] = useState<AssetSummary[]>([]);
  const [inYear, setInYear] = useState<AssetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [studiesRes, decisionsRes, inYearRes, mbpRes] = await Promise.allSettled([
        wb.studies(),
        wb.assets({ kind: 'decision' }),
        wb.assets({ kind: 'in_year_query' }),
        wb.growthDrivers(SEEDED_MBP.studyId),
      ]);
      if (cancelled) return;
      if (studiesRes.status === 'fulfilled') {
        setStudies(studiesRes.value.studies);
        setStudiesError(null);
      } else {
        setStudiesError(
          studiesRes.reason instanceof Error
            ? studiesRes.reason.message
            : String(studiesRes.reason),
        );
      }
      setDecisions(
        decisionsRes.status === 'fulfilled' ? decisionsRes.value.assets : [],
      );
      setInYear(
        inYearRes.status === 'fulfilled' ? inYearRes.value.assets : [],
      );
      setMbp(mbpRes.status === 'fulfilled' ? buildMbpRow(mbpRes.value) : null);
      setLoading(false);
    }
    void load();
    const t = window.setInterval(load, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  const q = query.trim().toLowerCase();

  const filteredMbps: MbpRow[] = useMemo(() => {
    const list = mbp ? [mbp] : [];
    if (!q) return list;
    return list.filter((row) =>
      [row.brand, row.mbpLabel, row.cycleWindow]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [mbp, q]);

  const filteredStudies = useMemo(() => {
    const ordered = [...studies].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
    if (!q) return ordered;
    return ordered.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.question.toLowerCase().includes(q),
    );
  }, [studies, q]);

  const filteredDecisions = useMemo(() => {
    if (!q) return decisions;
    return decisions.filter((a) => {
      const md = a.metadata ?? {};
      const recommendation = stringField(md.recommendation);
      return [
        recommendation,
        decisionScopeLabel(a),
        a.asset_key.join('/'),
      ]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [decisions, q]);

  const filteredInYear = useMemo(() => {
    if (!q) return inYear;
    return inYear.filter((a) => {
      const md = a.metadata ?? {};
      const boundTo = stringField(md.bound_to);
      return [boundTo, a.asset_key.join('/')]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [inYear, q]);

  const inYearByDecision = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of inYear) {
      const md = a.metadata ?? {};
      const boundTo = typeof md.bound_to === 'string' ? md.bound_to : '';
      if (!boundTo) continue;
      counts.set(boundTo, (counts.get(boundTo) ?? 0) + 1);
    }
    return counts;
  }, [inYear]);

  return (
    <main className="min-h-svh bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.10),transparent_32rem),linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)] px-4 py-8 font-sans text-slate-950 sm:px-6">
      <div className="mx-auto grid w-full max-w-5xl gap-6">
        <section className="grid gap-3">
          <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
            <FlaskConical className="h-3.5 w-3.5" />
            Diageo Research
          </div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="max-w-3xl text-balance text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              Pick what you want to work on.
            </h1>
            <Link
              href="/plan"
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-slate-950 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
            >
              <PencilLine className="h-3.5 w-3.5" />
              Start a new study
            </Link>
          </div>
        </section>

        <section>
          <label className="relative flex h-10 items-center rounded-full border border-slate-200 bg-white px-3 shadow-sm focus-within:border-slate-400">
            <Search className="mr-2 h-3.5 w-3.5 text-slate-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter planning contexts, studies, decisions, and in-year queries"
              className="h-full w-full bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
              aria-label="Filter"
            />
          </label>
        </section>

        {studiesError ? (
          <div className="rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-700">
            Workbench API unreachable · {studiesError}
          </div>
        ) : null}

        <SectionGroup
          title="Planning contexts"
          count={filteredMbps.length}
          loading={loading}
          empty="No planning contexts are seeded yet."
        >
          {filteredMbps.map((row) => (
            <MbpRowCard key={row.studyId} row={row} />
          ))}
        </SectionGroup>

        <SectionGroup
          title="Studies"
          count={filteredStudies.length}
          loading={loading}
          empty="No studies on disk yet. Run diageo study to seed one, or click ‘Start a new study’."
        >
          {filteredStudies.map((summary) => (
            <StudyRow key={summary.id} summary={summary} />
          ))}
        </SectionGroup>

        <SectionGroup
          title="Committed decisions"
          count={filteredDecisions.length}
          loading={loading}
          empty="No committed decisions yet. Commit one from /simulation."
        >
          {filteredDecisions.map((a) => (
            <DecisionRow
              key={a.asset_key_encoded}
              asset={a}
              inYearCount={inYearByDecision.get(decisionIdOf(a) ?? '') ?? 0}
            />
          ))}
        </SectionGroup>

        <SectionGroup
          title="In-year queries"
          count={filteredInYear.length}
          loading={loading}
          empty="No in-year queries yet. Ask one from a decision page."
        >
          {filteredInYear.map((a) => (
            <InYearRow key={a.asset_key_encoded} asset={a} />
          ))}
        </SectionGroup>

        <details className="text-[11px] leading-relaxed text-slate-500">
          <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-700">
            Analyst notes
          </summary>
          <p className="mt-1.5">
            API proxy: <code className="font-mono">/api/workbench/*</code> →{' '}
            <code className="font-mono">
              ${'{WORKBENCH_API_BASE:-http://127.0.0.1:8765}'}
            </code>
          </p>
        </details>
      </div>
    </main>
  );
}

function SectionGroup({
  title,
  count,
  loading,
  empty,
  children,
}: {
  title: string;
  count: number;
  loading: boolean;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <header className="flex items-baseline gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          {title}
        </h2>
        <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0 text-[10px] font-semibold tabular-nums text-slate-600">
          {loading ? '…' : count}
        </span>
      </header>
      {loading ? (
        <div className="h-16 animate-pulse rounded-2xl bg-slate-200/70" />
      ) : count === 0 ? (
        <p className="text-[12px] leading-snug text-slate-500">{empty}</p>
      ) : (
        <div className="grid gap-2">{children}</div>
      )}
    </section>
  );
}

function MbpRowCard({ row }: { row: MbpRow }) {
  return (
    <Link
      href={`/growth-driver?study=${row.studyId}`}
      className="group grid gap-2 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm shadow-slate-950/[0.04] transition-all hover:-translate-y-0.5 hover:border-slate-400"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold tracking-tight text-slate-950">
            {row.mbpLabel}
          </h3>
          <p className="mt-1 text-[12px] leading-snug text-slate-600">
            {row.brand} · {row.cycleWindow}
          </p>
        </div>
        <ArrowRight className="mt-1 h-4 w-4 text-slate-300 transition-colors group-hover:text-slate-700" />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
        <span className="tabular-nums">
          {row.mustDoCount} Must-Dos · {row.driverCount} Growth Drivers
        </span>
        {row.confidence ? (
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0 text-[10px] font-semibold text-slate-700">
            Confidence: {row.confidence}
          </span>
        ) : null}
      </div>
    </Link>
  );
}

function StudyRow({ summary }: { summary: StudySummary }) {
  return (
    <Link
      href={`/research?study=${summary.id}`}
      className="group grid gap-1.5 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm shadow-slate-950/[0.04] transition-all hover:-translate-y-0.5 hover:border-slate-400"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold tracking-tight text-slate-950">
              {humaniseName(summary.name)}
            </h3>
            <span className="font-mono text-[10px] text-slate-500">
              {summary.id}
            </span>
            <StatusPill status={summary.status} />
          </div>
          <p className="mt-1 max-w-3xl line-clamp-2 text-[13px] leading-snug text-slate-600">
            {summary.question}
          </p>
        </div>
        <ArrowRight className="mt-1 h-4 w-4 text-slate-300 transition-colors group-hover:text-slate-700" />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span className="tabular-nums">
          {summary.n_complete}/{summary.n_cells} scenarios
        </span>
        <span title={summary.created_at}>
          {formatTimestamp(summary.created_at)}
        </span>
      </div>
    </Link>
  );
}

function DecisionRow({
  asset,
  inYearCount,
}: {
  asset: AssetSummary;
  inYearCount: number;
}) {
  const md = asset.metadata ?? {};
  const recommendation =
    stringField(md.recommendation) || 'Committed decision';
  const committedAt = stringField(md.committed_at);
  const scopeLabel = decisionScopeLabel(asset);
  const decisionId = decisionIdOf(asset);
  const href = decisionId ? `/decision/${decisionId}` : `/assets/${asset.asset_key_encoded}`;
  return (
    <Link
      href={href}
      className="group grid gap-1.5 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm shadow-slate-950/[0.04] transition-all hover:-translate-y-0.5 hover:border-slate-400"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug tracking-tight text-slate-950">
            {recommendation}
          </h3>
          <p className="mt-1 text-[12px] leading-snug text-slate-600">
            Scope: {scopeLabel}
          </p>
        </div>
        <ArrowRight className="mt-1 h-4 w-4 text-slate-300 transition-colors group-hover:text-slate-700" />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span>{committedAt ? `Committed ${formatTimestamp(committedAt)}` : 'Commit time unknown'}</span>
        {inYearCount > 0 ? (
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0 text-[10px] font-semibold text-emerald-700">
            tested in-year {inYearCount} time{inYearCount === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>
    </Link>
  );
}

function InYearRow({ asset }: { asset: AssetSummary }) {
  const md = asset.metadata ?? {};
  const boundTo = stringField(md.bound_to);
  const askedAt = stringField(md.asked_at);
  const diff = (md.diff ?? {}) as Record<string, unknown>;
  const added = Array.isArray(diff.evidence_added) ? diff.evidence_added.length : 0;
  const invalidated = Array.isArray(diff.evidence_invalidated)
    ? diff.evidence_invalidated.length
    : 0;
  const changed = Array.isArray(diff.evidence_changed)
    ? diff.evidence_changed.length
    : 0;
  const diffSummary =
    added + invalidated + changed === 0
      ? 'No evidence change'
      : `${added} added · ${invalidated} invalidated · ${changed} shifted`;
  const href = boundTo ? `/decision/${boundTo}` : `/assets/${asset.asset_key_encoded}`;
  return (
    <Link
      href={href}
      className="group grid gap-1.5 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm shadow-slate-950/[0.04] transition-all hover:-translate-y-0.5 hover:border-slate-400"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold tracking-tight text-slate-950">
            {boundTo ? `Query bound to decision ${boundTo.slice(0, 12)}…` : 'In-year query'}
          </h3>
          <p className="mt-1 text-[12px] leading-snug text-slate-600">{diffSummary}</p>
        </div>
        <ArrowRight className="mt-1 h-4 w-4 text-slate-300 transition-colors group-hover:text-slate-700" />
      </div>
      <div className="text-[11px] text-slate-500">
        {askedAt ? `Asked ${formatTimestamp(askedAt)}` : 'Time unknown'}
      </div>
    </Link>
  );
}

function StatusPill({ status }: { status: StudySummary['status'] }) {
  const tone =
    status === 'complete'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : status === 'running'
        ? 'border-blue-200 bg-blue-50 text-blue-700'
        : status === 'error'
          ? 'border-orange-200 bg-orange-50 text-orange-700'
          : 'border-slate-200 bg-slate-50 text-slate-600';
  const label =
    status === 'complete'
      ? 'Complete'
      : status === 'running'
        ? 'Running'
        : status === 'error'
          ? 'Error'
          : 'Pending';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0 text-[10px] font-semibold',
        tone,
      )}
    >
      {label}
    </span>
  );
}

function buildMbpRow(res: GrowthDriversResponse): MbpRow {
  const mustDos = res.must_dos ?? [];
  const drivers = res.drivers ?? [];
  const confidence =
    mustDos.length > 0
      ? phraseConfidence(
          Math.round(
            mustDos.reduce((sum, m) => sum + Number(m.confidence ?? 0), 0) /
              mustDos.length,
          ),
        )
      : null;
  return {
    studyId: SEEDED_MBP.studyId,
    brand: SEEDED_MBP.brand,
    mbpLabel: SEEDED_MBP.mbpLabel,
    cycleWindow: SEEDED_MBP.cycleWindow,
    mustDoCount: mustDos.length,
    driverCount: drivers.length,
    confidence,
  };
}

function phraseConfidence(value: number): string {
  const word =
    value >= 75 ? 'High' : value >= 60 ? 'Medium' : value >= 40 ? 'Low' : 'Limited';
  return `${word} ${value}%`;
}

function decisionScopeLabel(asset: AssetSummary): string {
  const md = asset.metadata ?? {};
  const scope = (md.scope ?? {}) as Record<string, unknown>;
  const driver = stringField(scope.driver_id);
  if (driver) return `driver · ${driver}`;
  const finding = stringField(scope.finding_id);
  if (finding) return `finding · ${finding}`;
  const study = stringField(scope.study_id);
  if (study) return `study · ${study}`;
  return '—';
}

function decisionIdOf(asset: AssetSummary): string | undefined {
  if (asset.kind !== 'decision') return undefined;
  const md = asset.metadata ?? {};
  const fromMd = typeof md.decision_id === 'string' ? md.decision_id : null;
  if (fromMd) return fromMd;
  return asset.asset_key.at(-1) ?? undefined;
}

function stringField(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

function formatTimestamp(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = Date.now();
    const diffMs = now - d.getTime();
    const day = 86_400_000;
    if (diffMs < day) {
      const h = Math.max(1, Math.round(diffMs / 3_600_000));
      return `${h}h ago`;
    }
    if (diffMs < 7 * day) return `${Math.round(diffMs / day)}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

'use client';

/**
 * Home — the study list.
 *
 * Each row carries: humanised label, the question (one line), the
 * lead recommendation snippet (fetched lazily per-row), a confidence
 * pill, a status pill, last-run timestamp, scenario count. Clicking a
 * row opens /research?study=<id> as the default landing.
 *
 * At the top: a "Start a new study" CTA and a search input. The
 * surface-tile shortcuts (Robustness, Evidence, Plan, …) are kept as
 * a small footer block so frequent jumps still work, but they're not
 * the primary content anymore.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Clock,
  Compass,
  DatabaseZap,
  FlaskConical,
  Grid2X2,
  HelpCircle,
  Lightbulb,
  ListChecks,
  MessageCircle,
  PencilLine,
  Search,
  Settings2,
  ShieldAlert,
  Telescope,
  TrendingUp,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  wb,
  type SpecCurve,
  type StudySummary,
} from '@/components/workbench/types';
import { humaniseName } from '@/components/global-nav';

type LeadFetch = {
  loaded: boolean;
  lead: string | null;
  holds: number;
  total: number;
  robustness: number;
};

const SHORTCUT_TILES: Array<{ href: string; Icon: LucideIcon; title: string }> = [
  { href: '/research', Icon: Telescope, title: 'Research' },
  { href: '/answer', Icon: Lightbulb, title: 'Answer' },
  { href: '/robustness', Icon: Compass, title: 'Robustness' },
  { href: '/why-it-could-be-wrong', Icon: ShieldAlert, title: 'Why wrong?' },
  { href: '/scenario', Icon: ListChecks, title: 'Scenarios' },
  { href: '/growth-driver', Icon: TrendingUp, title: 'Growth Driver' },
  { href: '/evidence', Icon: HelpCircle, title: 'Evidence' },
  { href: '/assets', Icon: DatabaseZap, title: 'Assets' },
  { href: '/setup', Icon: Settings2, title: 'Setup' },
  { href: '/ask', Icon: MessageCircle, title: 'Ask' },
  { href: '/plan', Icon: PencilLine, title: 'Plan' },
  { href: '/simulation', Icon: FlaskConical, title: 'Simulation' },
  { href: '/workbench', Icon: Grid2X2, title: 'Workbench' },
];

export default function HomePage() {
  const [studies, setStudies] = useState<StudySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [leads, setLeads] = useState<Record<string, LeadFetch>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await wb.studies();
        if (cancelled) return;
        setStudies(res.studies);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }
    void load();
    const t = window.setInterval(load, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  // Lazy-load lead recommendation per study so the row can show
  // "Holds in N of M" without blocking the initial paint.
  useEffect(() => {
    let cancelled = false;
    const missing = studies.filter((s) => !leads[s.id]);
    if (missing.length === 0) return;
    for (const s of missing) {
      wb.specCurve(s.id)
        .then((curve) => {
          if (cancelled) return;
          setLeads((prev) => ({
            ...prev,
            [s.id]: summariseLead(curve),
          }));
        })
        .catch(() => {
          if (cancelled) return;
          setLeads((prev) => ({
            ...prev,
            [s.id]: {
              loaded: true,
              lead: null,
              holds: 0,
              total: 0,
              robustness: 0,
            },
          }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [studies, leads]);

  const ordered = useMemo(
    () =>
      [...studies].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      ),
    [studies],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.question.toLowerCase().includes(q),
    );
  }, [ordered, query]);

  return (
    <main className="min-h-svh bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.10),transparent_32rem),linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)] px-4 py-8 font-sans text-slate-950 sm:px-6">
      <div className="mx-auto grid w-full max-w-5xl gap-6">
        <section className="grid gap-2">
          <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
            <FlaskConical className="h-3.5 w-3.5" />
            Diageo Research
          </div>
          <h1 className="max-w-3xl text-balance text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
            Pick a study to read its findings.
          </h1>
        </section>

        <section className="flex flex-wrap items-center gap-2">
          <Link
            href="/plan"
            className="inline-flex h-10 items-center gap-2 rounded-full bg-slate-950 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
          >
            <PencilLine className="h-3.5 w-3.5" />
            Start a new study
          </Link>
          <label className="relative flex h-10 min-w-[280px] flex-1 items-center rounded-full border border-slate-200 bg-white px-3 shadow-sm focus-within:border-slate-400">
            <Search className="mr-2 h-3.5 w-3.5 text-slate-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter studies by name, id, or question"
              className="h-full w-full bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
              aria-label="Filter studies"
            />
          </label>
        </section>

        {error ? (
          <div className="rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-700">
            Workbench API unreachable · {error}
          </div>
        ) : null}

        <section className="grid gap-2" aria-label="Studies">
          {loading ? (
            <div className="grid gap-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="h-28 animate-pulse rounded-2xl bg-slate-200/70"
                />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 p-5 text-sm text-slate-600">
              {ordered.length === 0
                ? 'No studies on disk yet. Run `diageo study` to seed one, or click “Start a new study”.'
                : 'No studies match your filter.'}
            </div>
          ) : (
            filtered.map((s) => (
              <StudyRow key={s.id} summary={s} lead={leads[s.id]} />
            ))
          )}
        </section>

        <section className="grid gap-2">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            Jump to a job
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {SHORTCUT_TILES.map((tile) => (
              <Link
                key={tile.href}
                href={tile.href}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-slate-200 bg-white/80 px-3 text-[12px] font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-white"
              >
                <tile.Icon className="h-3.5 w-3.5 text-slate-500" />
                {tile.title}
              </Link>
            ))}
          </div>
        </section>

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

function StudyRow({
  summary,
  lead,
}: {
  summary: StudySummary;
  lead: LeadFetch | undefined;
}) {
  const href = `/research?study=${summary.id}`;
  return (
    <Link
      href={href}
      className="group grid gap-2 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm shadow-slate-950/[0.04] transition-all hover:-translate-y-0.5 hover:border-slate-400"
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
          <p className="mt-1 max-w-3xl text-[13px] leading-snug text-slate-600">
            {summary.question}
          </p>
        </div>
        <ArrowRight className="mt-1 h-4 w-4 text-slate-300 transition-colors group-hover:text-slate-700" />
      </div>
      <div className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <p className="line-clamp-1 text-[12px] leading-snug text-slate-700">
          {lead?.loaded
            ? lead.lead
              ? `Lead: ${lead.lead}`
              : 'No lead recommendation has clustered yet.'
            : 'Reading lead recommendation…'}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          {lead?.loaded && lead.total > 0 ? (
            <ConfidencePill
              holds={lead.holds}
              total={lead.total}
              robustness={lead.robustness}
            />
          ) : null}
          <span className="tabular-nums">
            {summary.n_complete}/{summary.n_cells} scenarios
          </span>
          <span title={summary.created_at}>
            {formatTimestamp(summary.created_at)}
          </span>
        </div>
      </div>
    </Link>
  );
}

function ConfidencePill({
  holds,
  total,
  robustness,
}: {
  holds: number;
  total: number;
  robustness: number;
}) {
  const tone =
    robustness >= 0.7
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : robustness >= 0.4
        ? 'border-yellow-200 bg-yellow-50 text-yellow-700'
        : 'border-orange-200 bg-orange-50 text-orange-700';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums',
        tone,
      )}
    >
      Holds in {holds} of {total}
    </span>
  );
}

function StatusPill({ status }: { status: StudySummary['status'] }) {
  switch (status) {
    case 'complete':
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0 text-[10px] font-semibold text-emerald-700">
          <CheckCircle2 className="h-2.5 w-2.5" /> Complete
        </span>
      );
    case 'running':
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0 text-[10px] font-semibold text-blue-700">
          <Clock className="h-2.5 w-2.5 animate-pulse" /> Running
        </span>
      );
    case 'error':
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-orange-200 bg-orange-50 px-2 py-0 text-[10px] font-semibold text-orange-700">
          <XCircle className="h-2.5 w-2.5" /> Error
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0 text-[10px] font-semibold text-slate-600">
          <Circle className="h-2.5 w-2.5" /> Pending
        </span>
      );
  }
}

function summariseLead(curve: SpecCurve): LeadFetch {
  const lead = curve.rows[0];
  if (!lead) {
    return { loaded: true, lead: null, holds: 0, total: 0, robustness: 0 };
  }
  const total = lead.n_agree + lead.n_weaker + lead.n_flips + lead.n_missing;
  const cleaned = cleanRepresentative(lead.representative);
  const text =
    cleaned
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)[0]
      ?.slice(0, 160) ?? cleaned.slice(0, 160);
  return {
    loaded: true,
    lead: text,
    holds: lead.n_agree,
    total,
    robustness: lead.robustness,
  };
}

function cleanRepresentative(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  const cutMatch = trimmed.search(/##\s*Pre-?registration|##\s+/i);
  const sliced = cutMatch >= 0 ? trimmed.slice(0, cutMatch) : trimmed;
  return sliced
    .replace(/\*\*/g, '')
    .replace(/_+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatTimestamp(iso: string): string {
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
    if (diffMs < 7 * day) {
      return `${Math.round(diffMs / day)}d ago`;
    }
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

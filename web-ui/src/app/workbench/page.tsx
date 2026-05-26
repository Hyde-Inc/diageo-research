'use client';

/**
 * Hypothesis Workbench page.
 *
 * One question across a multiverse of defensible specifications.
 * Information architecture, top-down:
 *
 *   1. Subject hero: the QUESTION leads, with a one-line "what we're
 *      checking" (the prereg decision rule). Status pills + cell counter
 *      sit beside it. Run metadata is collapsed under a small disclosure.
 *   2. Recipes: cards strip — one selected card today, with a subtle
 *      "+ add recipe" affordance for future parallel recipes.
 *   3. Tabs: Recipe / Universe / Spec curve / Lineage / Ask.
 *
 * Cell selection is owned at the page level so that clicking a cell in
 * one pane keeps it active in every other pane and the side detail
 * sheet. "Open in lineage" links from the cell detail sheet jump the
 * user to the Lineage tab without losing selection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BookOpen,
  ChevronDown,
  DatabaseZap,
  GitGraph,
  RefreshCw,
  Sparkles,
  Telescope,
  Receipt,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PaneAsk } from '@/components/workbench/pane-ask';
import { PaneDag } from '@/components/workbench/pane-dag';
import { PaneRecipe } from '@/components/workbench/pane-recipe';
import { PaneSpecCurve } from '@/components/workbench/pane-spec-curve';
import { PaneUniverse } from '@/components/workbench/pane-universe';
import { RecipeCards } from '@/components/workbench/recipe-cards';
import { StudyPicker } from '@/components/workbench/study-picker';
import {
  wb,
  type Prereg,
  type SpecCurve,
  type StudyCost,
  type StudyDetail,
  type StudySummary,
} from '@/components/workbench/types';

type PaneId = 'recipe' | 'universe' | 'curve' | 'dag' | 'ask';
type StudyFetch<T> = {
  key: string;
  value: T | null;
};

const PANES: Array<{ id: PaneId; label: string; Icon: typeof GitGraph }> = [
  { id: 'recipe', label: 'Recipe', Icon: BookOpen },
  { id: 'universe', label: 'Universe', Icon: Telescope },
  { id: 'curve', label: 'Spec curve', Icon: Receipt },
  { id: 'dag', label: 'Lineage', Icon: GitGraph },
  { id: 'ask', label: 'Ask', Icon: Sparkles },
];

export default function WorkbenchPage() {
  const [studies, setStudies] = useState<StudySummary[]>([]);
  const [studyId, setStudyId] = useState<string | null>(null);
  const [detailFetch, setDetailFetch] = useState<StudyFetch<StudyDetail> | null>(null);
  const [curveFetch, setCurveFetch] = useState<StudyFetch<SpecCurve> | null>(null);
  const [costFetch, setCostFetch] = useState<StudyFetch<StudyCost> | null>(null);
  const [preregFetch, setPreregFetch] = useState<StudyFetch<Prereg> | null>(null);
  const [pane, setPane] = useState<PaneId>('recipe');
  const [studiesError, setStudiesError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const studyFetchKey = studyId ? `${studyId}:${refreshKey}` : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Studies index — poll every 7s so a freshly launched study lands in
  // the picker without a hard refresh.
  useEffect(() => {
    let cancelled = false;
    async function loadStudies() {
      try {
        const res = await wb.studies();
        if (cancelled || !mountedRef.current) return;
        setStudiesError(null);
        setStudies(res.studies);
        if (!studyId && res.studies.length > 0) {
          const candidate =
            res.studies.find((s) => s.n_complete > 0) ?? res.studies[0];
          setStudyId(candidate.id);
        }
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        setStudiesError(err instanceof Error ? err.message : String(err));
      }
    }
    void loadStudies();
    const t = window.setInterval(loadStudies, 7000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [studyId]);

  // Study detail + spec curve + cost + prereg. Hoisted to the page so
  // every pane consumes the same payload and the subject hero can show
  // the prereg's "what we're checking" line without a secondary fetch.
  useEffect(() => {
    if (!studyId || !studyFetchKey) return;
    let cancelled = false;
    wb.study(studyId)
      .then((d) => {
        if (!cancelled) setDetailFetch({ key: studyFetchKey, value: d });
      })
      .catch(() => {
        if (!cancelled) setDetailFetch({ key: studyFetchKey, value: null });
      });
    wb.specCurve(studyId)
      .then((c) => {
        if (cancelled) return;
        setCurveFetch({ key: studyFetchKey, value: c });
        setActiveCellId((cur) =>
          cur && c.cells.some((x) => x.id === cur) ? cur : null,
        );
      })
      .catch(() => {
        if (!cancelled) setCurveFetch({ key: studyFetchKey, value: null });
      });
    wb.cost(studyId)
      .then((c) => {
        if (!cancelled) setCostFetch({ key: studyFetchKey, value: c });
      })
      .catch(() => {
        if (!cancelled) setCostFetch({ key: studyFetchKey, value: null });
      });
    wb.prereg(studyId)
      .then((p) => {
        if (!cancelled) setPreregFetch({ key: studyFetchKey, value: p });
      })
      .catch(() => {
        if (!cancelled) setPreregFetch({ key: studyFetchKey, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [studyId, studyFetchKey]);

  const detail =
    studyFetchKey && detailFetch?.key === studyFetchKey ? detailFetch.value : null;
  const curve =
    studyFetchKey && curveFetch?.key === studyFetchKey ? curveFetch.value : null;
  const cost =
    studyFetchKey && costFetch?.key === studyFetchKey ? costFetch.value : null;
  const prereg =
    studyFetchKey && preregFetch?.key === studyFetchKey ? preregFetch.value : null;
  const loadingDetail = Boolean(
    studyFetchKey && detailFetch?.key !== studyFetchKey,
  );
  const loadingCurve = Boolean(
    studyFetchKey && curveFetch?.key !== studyFetchKey,
  );
  const loadingCost = Boolean(
    studyFetchKey && costFetch?.key !== studyFetchKey,
  );

  const studySummary = useMemo(
    () => studies.find((s) => s.id === studyId) ?? null,
    [studies, studyId],
  );

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleSelectCell = useCallback((id: string) => {
    setActiveCellId(id);
  }, []);

  const handleOpenInLineage = useCallback((id: string) => {
    setActiveCellId(id);
    setPane('dag');
  }, []);

  return (
    <div className="min-h-svh bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.10),transparent_32rem),linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)] font-sans text-slate-950">
      <header className="border-b border-slate-200/80 bg-white/80 px-4 py-3 shadow-sm shadow-slate-950/[0.03] backdrop-blur sm:px-6">
        <div className="mx-auto flex w-full max-w-[1500px] flex-wrap items-center gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-blue-200 bg-blue-50 text-blue-700 shadow-sm">
              <DatabaseZap className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-sm font-semibold tracking-tight text-slate-950 sm:text-base">
                  Hypothesis Workbench
                </h1>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Multiverse
                </span>
              </div>
              <p className="truncate text-xs text-slate-500">
                One question, run across many defensible specifications. Pick the
                pane that matches your question.
              </p>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <StudyPicker
              studies={studies}
              studyId={studyId}
              onChange={(id) => {
                setStudyId(id);
                setActiveCellId(null);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 rounded-full border-slate-200 bg-white px-3 text-xs shadow-sm hover:bg-slate-50"
              onClick={handleRefresh}
              disabled={!studyId || loadingCurve || loadingCost}
            >
              <RefreshCw
                className={cn(
                  'h-3.5 w-3.5',
                  (loadingCurve || loadingCost) && 'animate-spin',
                )}
              />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <main className="px-4 py-5 sm:px-6">
        <div className="mx-auto grid w-full max-w-[1500px] gap-4">
          <Subject
            detail={detail}
            summary={studySummary}
            prereg={prereg}
            loading={loadingDetail}
            studiesError={studiesError}
          />

          <RecipeCards
            detail={detail}
            summary={studySummary}
            selectedRecipeId={detail?.id ?? null}
            onSelectRecipe={() => undefined}
          />

          <Tabs pane={pane} onPane={setPane} />

          {pane === 'recipe' ? (
            <PaneRecipe
              studyId={studyId}
              detail={detail}
              loadingDetail={loadingDetail}
              prereg={prereg}
              curve={curve}
              loading={loadingCurve}
            />
          ) : pane === 'dag' ? (
            <PaneDag
              curve={curve}
              loading={loadingCurve}
              cellId={activeCellId}
              onSelectCell={handleSelectCell}
              onOpenInLineage={handleOpenInLineage}
            />
          ) : pane === 'universe' ? (
            <PaneUniverse
              curve={curve}
              loading={loadingCurve}
              cellId={activeCellId}
              onSelectCell={handleSelectCell}
              onOpenInLineage={handleOpenInLineage}
            />
          ) : pane === 'curve' ? (
            <PaneSpecCurve
              curve={curve}
              cost={cost}
              loading={loadingCurve}
              costLoading={loadingCost}
              cellId={activeCellId}
              onSelectCell={handleSelectCell}
              onOpenInLineage={handleOpenInLineage}
            />
          ) : (
            <PaneAsk detail={detail} curve={curve} />
          )}
        </div>
      </main>
    </div>
  );
}

function Subject({
  detail,
  summary,
  prereg,
  loading,
  studiesError,
}: {
  detail: StudyDetail | null;
  summary: StudySummary | null;
  prereg: Prereg | null;
  loading: boolean;
  studiesError: string | null;
}) {
  if (studiesError) {
    return (
      <div className="rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-700 shadow-sm">
        Workbench API unreachable · {studiesError}
      </div>
    );
  }

  if (!detail) {
    if (loading) {
      return (
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-sm">
          <div className="grid gap-2">
            <div className="h-7 w-2/3 animate-pulse rounded-lg bg-slate-200" />
            <div className="h-4 w-1/3 animate-pulse rounded-lg bg-slate-100" />
          </div>
        </div>
      );
    }
    return (
      <div className="rounded-3xl border border-dashed border-slate-300 bg-white/70 p-5 text-sm text-slate-500 shadow-sm">
        Pick a study from the top right to begin.
      </div>
    );
  }

  const created = detail.created_at
    ? new Date(detail.created_at)
    : null;
  const errorCount = summary?.n_error ?? 0;
  const completeCount = summary?.n_complete ?? detail.cells.length;
  const cellCount = summary?.n_cells ?? detail.cells.length;
  const decisionRulePreview = prereg?.decision_rule
    ? truncate(prereg.decision_rule, 220)
    : null;

  return (
    <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white/90 shadow-sm shadow-slate-950/[0.04] backdrop-blur">
      <div className="grid gap-3 p-5 lg:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Question
          </span>
          <StatusPill status={detail.status} />
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
            <Activity className="h-3.5 w-3.5 text-slate-400" />
            {completeCount}/{cellCount} cells complete
          </span>
          {errorCount > 0 ? (
            <span className="rounded-full bg-orange-50 px-2.5 py-1 text-xs font-medium text-orange-700">
              {errorCount} {errorCount === 1 ? 'error' : 'errors'}
            </span>
          ) : null}
        </div>
        <h2 className="max-w-5xl text-balance text-2xl font-semibold leading-tight tracking-tight text-slate-950 md:text-[28px]">
          {detail.question}
        </h2>
        {decisionRulePreview ? (
          <div className="grid gap-1 rounded-2xl border border-blue-100 bg-blue-50/60 px-4 py-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-700">
              What we&apos;re checking
            </span>
            <p className="text-sm leading-snug text-slate-800">
              {decisionRulePreview}
            </p>
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            No decision rule registered for this study yet.
          </p>
        )}
      </div>
      <details className="group border-t border-slate-100 bg-slate-50/70">
        <summary className="flex cursor-pointer select-none items-center gap-2 px-5 py-2 text-[11px] text-slate-500">
          <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
          <span className="font-mono uppercase tracking-wider">Run metadata</span>
          <span className="text-slate-400">·</span>
          <span className="font-mono">{detail.id}</span>
        </summary>
        <dl className="grid gap-2 px-5 pb-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <MetaCell label="Name" value={detail.name} mono />
          <MetaCell label="Study ID" value={detail.id} mono />
          <MetaCell
            label="Started"
            value={created ? created.toLocaleString() : '—'}
          />
          {detail.spec_path ? (
            <MetaCell label="Spec path" value={detail.spec_path} mono />
          ) : null}
          {detail.prereg_path ? (
            <MetaCell label="Prereg path" value={detail.prereg_path} mono />
          ) : null}
          {prereg?.signed_by ? (
            <MetaCell label="Signed by" value={prereg.signed_by} />
          ) : null}
        </dl>
      </details>
    </section>
  );
}

function MetaCell({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid gap-0.5 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </dt>
      <dd
        className={cn(
          'truncate text-slate-800',
          mono ? 'font-mono text-[11px]' : 'text-xs',
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function StatusPill({ status }: { status: StudyDetail['status'] }) {
  const tone =
    status === 'complete'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : status === 'running'
        ? 'border-blue-200 bg-blue-50 text-blue-700'
        : status === 'error'
          ? 'border-orange-200 bg-orange-50 text-orange-700'
          : 'border-slate-200 bg-slate-100 text-slate-600';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide shadow-sm',
        tone,
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          status === 'complete' && 'bg-emerald-500',
          status === 'running' && 'animate-pulse bg-blue-500',
          status === 'error' && 'bg-orange-500',
          status === 'pending' && 'bg-slate-400',
        )}
      />
      {status}
    </span>
  );
}

function Tabs({
  pane,
  onPane,
}: {
  pane: PaneId;
  onPane: (p: PaneId) => void;
}) {
  return (
    <nav className="rounded-2xl border border-slate-200 bg-white/90 p-1.5 shadow-sm shadow-slate-950/[0.03] backdrop-blur">
      <div className="grid gap-1 sm:grid-cols-5">
        {PANES.map((p) => {
          const active = pane === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onPane(p.id)}
              className={cn(
                'inline-flex h-10 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium transition-all',
                active
                  ? 'bg-slate-950 text-white shadow-sm'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-950',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <p.Icon
                className={cn(
                  'h-4 w-4',
                  active ? 'text-blue-200' : 'text-slate-400',
                )}
              />
              {p.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

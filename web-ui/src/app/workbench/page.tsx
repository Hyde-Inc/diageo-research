'use client';

/**
 * Hypothesis Workbench page.
 *
 * One question across a multiverse of defensible specifications.
 * Page-level header shows the study question, picker, and refresh.
 * Four tabs (Recipe / Lineage / Universe / Spec curve) own the
 * detail panes; each pane focuses on rendering, not narration.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BookOpen,
  DatabaseZap,
  GitGraph,
  RefreshCw,
  Telescope,
  Receipt,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PaneDag } from '@/components/workbench/pane-dag';
import { PaneRecipe } from '@/components/workbench/pane-recipe';
import { PaneSpecCurve } from '@/components/workbench/pane-spec-curve';
import { PaneUniverse } from '@/components/workbench/pane-universe';
import { StudyPicker } from '@/components/workbench/study-picker';
import {
  wb,
  type SpecCurve,
  type StudyCost,
  type StudyDetail,
  type StudySummary,
} from '@/components/workbench/types';

type PaneId = 'recipe' | 'dag' | 'universe' | 'curve';
type StudyFetch<T> = {
  key: string;
  value: T | null;
};

const PANES: Array<{ id: PaneId; label: string; Icon: typeof GitGraph }> = [
  { id: 'recipe', label: 'Recipe', Icon: BookOpen },
  { id: 'dag', label: 'Lineage', Icon: GitGraph },
  { id: 'universe', label: 'Universe', Icon: Telescope },
  { id: 'curve', label: 'Spec curve', Icon: Receipt },
];

export default function WorkbenchPage() {
  const [studies, setStudies] = useState<StudySummary[]>([]);
  const [studyId, setStudyId] = useState<string | null>(null);
  const [detailFetch, setDetailFetch] = useState<StudyFetch<StudyDetail> | null>(null);
  const [curveFetch, setCurveFetch] = useState<StudyFetch<SpecCurve> | null>(null);
  const [costFetch, setCostFetch] = useState<StudyFetch<StudyCost> | null>(null);
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

  // Study detail + spec curve + cost. Hoisted to the page so the
  // subject block can render the question, and panes don't each
  // re-fetch the same StudyDetail.
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
                Run orchestration, lineage, sensitivity, and cost in one pane dashboard.
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
            loading={loadingDetail}
            studiesError={studiesError}
          />

          <Tabs pane={pane} onPane={setPane} />

          {pane === 'recipe' ? (
            <PaneRecipe
              studyId={studyId}
              detail={detail}
              loadingDetail={loadingDetail}
              curve={curve}
              loading={loadingCurve}
            />
          ) : pane === 'dag' ? (
            <PaneDag
              curve={curve}
              loading={loadingCurve}
              cellId={activeCellId}
              onSelectCell={handleSelectCell}
            />
          ) : pane === 'universe' ? (
            <PaneUniverse
              curve={curve}
              loading={loadingCurve}
              cellId={activeCellId}
              onSelectCell={handleSelectCell}
            />
          ) : (
            <PaneSpecCurve
              curve={curve}
              cost={cost}
              loading={loadingCurve}
              costLoading={loadingCost}
              cellId={activeCellId}
              onSelectCell={handleSelectCell}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function Subject({
  detail,
  summary,
  loading,
  studiesError,
}: {
  detail: StudyDetail | null;
  summary: StudySummary | null;
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

  return (
    <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white/90 shadow-sm shadow-slate-950/[0.04] backdrop-blur">
      <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="grid min-w-0 gap-2">
          <div className="flex flex-wrap items-center gap-2">
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
          <h2 className="max-w-5xl text-balance text-2xl font-semibold leading-tight tracking-tight text-slate-950 md:text-3xl">
            {detail.question}
          </h2>
        </div>
        <dl className="grid gap-1.5 rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs shadow-inner lg:min-w-[280px]">
          <div className="flex min-w-0 justify-between gap-3">
            <dt className="text-slate-500">Study ID</dt>
            <dd className="truncate font-mono text-slate-700">{detail.id}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Started</dt>
            <dd className="text-right text-slate-700">
              {created ? created.toLocaleString() : '—'}
            </dd>
          </div>
        </dl>
      </div>
      <div className="border-t border-slate-100 bg-slate-50/70 px-5 py-2.5 text-xs text-slate-500">
        <span className="font-medium text-slate-700">{detail.name}</span>
        {detail.spec_path ? (
          <span className="ml-2 font-mono text-slate-500">{detail.spec_path}</span>
        ) : null}
      </div>
    </section>
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
      <div className="grid gap-1 sm:grid-cols-4">
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

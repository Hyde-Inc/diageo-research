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
  BookOpen,
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
    <div className="grid min-h-svh grid-rows-[auto_1fr] bg-background">
      <header className="border-b bg-background px-4 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-3">
          <div>
            <h1 className="text-base font-semibold tracking-tight">
              Hypothesis Workbench
            </h1>
            <p className="text-xs text-muted-foreground">
              Multiverse research runs over a single question.
            </p>
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
              className="h-8 gap-1.5 text-xs"
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

      <main className="px-4 py-6 sm:px-6">
        <div className="mx-auto grid w-full max-w-7xl gap-6">
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
      <div className="border-l-2 border-orange-500 bg-orange-500/5 px-4 py-3 text-sm text-orange-600 dark:text-orange-400">
        Workbench API unreachable · {studiesError}
      </div>
    );
  }

  if (!detail) {
    if (loading) {
      return (
        <div className="grid gap-2">
          <div className="h-7 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
        </div>
      );
    }
    return (
      <div className="text-sm text-muted-foreground">
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
    <section className="grid gap-3">
      <h2 className="max-w-4xl text-lg font-semibold leading-snug tracking-tight text-foreground md:text-xl">
        {detail.question}
      </h2>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <StatusPill status={detail.status} />
        <span>
          <span className="text-foreground">{completeCount}</span>
          <span className="text-muted-foreground"> / {cellCount} cells</span>
        </span>
        {errorCount > 0 ? (
          <span className="text-orange-500">
            {errorCount} {errorCount === 1 ? 'error' : 'errors'}
          </span>
        ) : null}
        <span className="font-mono text-muted-foreground/80">{detail.id}</span>
        {created ? (
          <span className="text-muted-foreground/80">
            started {created.toLocaleString()}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function StatusPill({ status }: { status: StudyDetail['status'] }) {
  const tone =
    status === 'complete'
      ? 'bg-green-500/15 text-green-600 dark:text-green-400'
      : status === 'running'
        ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
        : status === 'error'
          ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400'
          : 'bg-muted text-muted-foreground';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide',
        tone,
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          status === 'complete' && 'bg-green-500',
          status === 'running' && 'animate-pulse bg-blue-500',
          status === 'error' && 'bg-orange-500',
          status === 'pending' && 'bg-muted-foreground',
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
    <nav className="-mb-px flex flex-wrap items-end gap-1 border-b">
      {PANES.map((p) => {
        const active = pane === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onPane(p.id)}
            className={cn(
              'inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
            aria-current={active ? 'page' : undefined}
          >
            <p.Icon className="h-4 w-4" />
            {p.label}
          </button>
        );
      })}
    </nav>
  );
}

'use client';

/**
 * /ask — natural-language Q&A over the active study.
 *
 * Posts to `POST /studies/{id}/ask` (proxied via `/api/workbench/*`),
 * renders the structured `{ answer, citations, unknowns }` payload, and
 * — critically — surfaces backend failures as visible errors rather
 * than silently falling back to a stub. The conversation card itself
 * lives in `@/components/workbench/pane-ask` so the same surface is
 * reused inside the Workbench Ask tab.
 *
 * Scenario context: the page honours a `?scenario=<id>` URL param so
 * deep links from /scenario, /robustness, or the workbench can land
 * here pre-scoped. The request body carries scenario_id and the UI
 * shows a "scoped to ..." badge whenever a scenario is active.
 */

import { Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { Focus, MessageCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData } from '@/components/study/use-study';
import { AskConversation } from '@/components/workbench/pane-ask';

function AskPageBody() {
  const data = useStudyData();
  const { studyId, detail, curve, loadingDetail, loadingCurve } = data;
  const search = useSearchParams();
  const scenarioParam = search.get('scenario');

  const scenarioId = useMemo<string | null>(() => {
    if (!scenarioParam || !detail) return null;
    return detail.cells.some((c) => c.id === scenarioParam)
      ? scenarioParam
      : null;
  }, [scenarioParam, detail]);

  const scenarioLabel = useMemo(
    () => (scenarioId ? humaniseScenarioId(scenarioId) : null),
    [scenarioId],
  );

  const completedCount = useMemo(
    () => curve?.cells?.filter((c) => c.status === 'complete').length ?? 0,
    [curve],
  );

  const ready = Boolean(studyId && detail);
  const loading = loadingDetail || loadingCurve;

  return (
    <StudyShell
      data={data}
      eyebrow="Ask"
      title="Ask in plain language"
      intro="Answers come from this study's own brief, cross-scenario summary, and the conditions that would prove it wrong — paraphrased, never parroted."
    >
      {!studyId ? null : loading ? (
        <FocusCard tone="muted">
          <div className="grid gap-3">
            <div className="h-5 w-1/3 animate-pulse rounded-lg bg-slate-200" />
            <div className="h-24 w-full animate-pulse rounded-lg bg-slate-200/60" />
          </div>
        </FocusCard>
      ) : (
        <>
          <ScopeBanner
            ready={ready}
            scenarioLabel={scenarioLabel}
            completedCount={completedCount}
            totalCount={curve?.n_cells ?? null}
          />
          <FocusCard className="p-0 sm:p-0">
            <AskConversation
              studyId={studyId}
              detail={detail}
              curve={curve}
              activeCellId={scenarioId}
              layout="page"
            />
          </FocusCard>
        </>
      )}
    </StudyShell>
  );
}

export default function AskPage() {
  // useSearchParams() must be wrapped in Suspense at the page boundary.
  return (
    <Suspense fallback={null}>
      <AskPageBody />
    </Suspense>
  );
}

function ScopeBanner({
  ready,
  scenarioLabel,
  completedCount,
  totalCount,
}: {
  ready: boolean;
  scenarioLabel: string | null;
  completedCount: number;
  totalCount: number | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-600">
      <Badge
        variant="outline"
        className="inline-flex items-center gap-1 border-slate-200 bg-white text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500"
      >
        <MessageCircle className="h-3 w-3" />
        Grounded Q&amp;A
      </Badge>
      {scenarioLabel ? (
        <Badge
          variant="outline"
          className="inline-flex items-center gap-1 border-blue-200 bg-blue-50 text-[10px] font-semibold uppercase tracking-[0.18em] text-blue-700"
        >
          <Focus className="h-3 w-3" />
          Scoped to {scenarioLabel}
        </Badge>
      ) : null}
      {ready ? (
        <span className="text-[11px] text-slate-500">
          {completedCount > 0
            ? `${completedCount} of ${totalCount ?? '—'} scenarios complete.`
            : 'No scenarios are complete yet — answers will be light.'}
        </span>
      ) : null}
    </div>
  );
}

function humaniseScenarioId(id: string): string {
  const parts = id.split('__').filter(Boolean);
  if (parts.length === 0) return id;
  // Ids look like dimension__value__dimension__value — pair them.
  const pairs: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const dim = parts[i].replace(/[-_]+/g, ' ');
    const val = (parts[i + 1] ?? '').replace(/[-_]+/g, ' ');
    pairs.push(val ? `${dim}: ${val}` : dim);
  }
  return pairs.join(' · ');
}

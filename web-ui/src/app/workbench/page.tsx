'use client';

/**
 * Hypothesis Workbench page.
 *
 * Three panes on top of the Diageo research FastAPI:
 *   - DAG          → declared Dagster asset graph, click a node
 *                    to inspect the per-stage materialization record
 *                    for the selected cell.
 *   - Universe     → multiverse heatmap (cells × clustered
 *                    recommendations), coloured by spec-curve status.
 *   - Spec curve   → clustered recommendations table + per-cell cost
 *                    histogram with cap-aware colours.
 *
 * Pane-switching, study picker, refresh button, and the cell-detail
 * sheet live here so the panes themselves stay focused on rendering.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  ExternalLink,
  FlaskConical,
  GitGraph,
  RefreshCw,
  Telescope,
  Activity,
  Receipt,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
  type StudySummary,
} from '@/components/workbench/types';

type PaneId = 'recipe' | 'dag' | 'universe' | 'curve';

const PANES: Array<{
  id: PaneId;
  label: string;
  blurb: string;
  Icon: typeof GitGraph;
}> = [
  {
    id: 'recipe',
    label: 'Recipe',
    blurb: 'Axes · defaults · prereg · falsifiers',
    Icon: BookOpen,
  },
  {
    id: 'dag',
    label: 'DAG',
    blurb: 'Dagster lineage + materializations',
    Icon: GitGraph,
  },
  {
    id: 'universe',
    label: 'Universe',
    blurb: 'Cells × spec-curve heatmap',
    Icon: Telescope,
  },
  {
    id: 'curve',
    label: 'Spec curve + Cost',
    blurb: 'Clustered recs · cap-aware spend',
    Icon: Receipt,
  },
];

export default function WorkbenchPage() {
  const [studies, setStudies] = useState<StudySummary[]>([]);
  const [studyId, setStudyId] = useState<string | null>(null);
  const [curve, setCurve] = useState<SpecCurve | null>(null);
  const [cost, setCost] = useState<StudyCost | null>(null);
  const [pane, setPane] = useState<PaneId>('recipe');
  const [studiesError, setStudiesError] = useState<string | null>(null);
  const [loadingCurve, setLoadingCurve] = useState(false);
  const [loadingCost, setLoadingCost] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Studies index — poll every 7s so a freshly launched study lands in
  // the picker without needing a reload. Cheap GET (no per-cell IO).
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

  useEffect(() => {
    if (!studyId) {
      setCurve(null);
      setCost(null);
      return;
    }
    let cancelled = false;
    setLoadingCurve(true);
    setLoadingCost(true);
    wb.specCurve(studyId)
      .then((c) => {
        if (cancelled) return;
        setCurve(c);
        setActiveCellId((cur) =>
          cur && c.cells.some((x) => x.id === cur) ? cur : null,
        );
      })
      .catch(() => {
        if (cancelled) return;
        setCurve(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingCurve(false);
      });
    wb.cost(studyId)
      .then((c) => {
        if (cancelled) return;
        setCost(c);
      })
      .catch(() => {
        if (cancelled) return;
        setCost(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingCost(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studyId, refreshKey]);

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
      <header className="grid gap-2 border-b bg-background px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="grid gap-0.5">
            <h1 className="text-sm font-semibold tracking-tight">
              Hypothesis Workbench
            </h1>
            <p className="text-[11px] text-muted-foreground">
              Diageo research · multiverse runs over the same question
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
              className="h-7 gap-1 text-[10px]"
              onClick={handleRefresh}
              disabled={!studyId || loadingCurve || loadingCost}
            >
              <RefreshCw
                className={cn(
                  'h-3 w-3',
                  (loadingCurve || loadingCost) && 'animate-spin',
                )}
              />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <main className="px-4 py-4 sm:px-6">
        <div className="mx-auto grid w-full max-w-7xl gap-4">
          <ValueStrip />

          <PaneBar
            pane={pane}
            onPane={setPane}
            studySummary={studySummary}
            studiesError={studiesError}
          />

          <PaneIntro pane={pane} />

          {pane === 'recipe' ? (
            <PaneRecipe
              studyId={studyId}
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

function ValueStrip() {
  const uses = [
    {
      icon: GitGraph,
      label: 'Lineage',
      body: 'Real Dagster asset graph, click a node to open the per-stage materialization receipt (partition, model, spend, hashes).',
    },
    {
      icon: Telescope,
      label: 'Robustness',
      body: 'See which recommendations survive every defensible specification, and which only show up in one framing.',
    },
    {
      icon: Receipt,
      label: 'Cost discipline',
      body: 'Per-cell spend rendered against its declared max_cost_usd — orange bars mean the cap caught us.',
    },
    {
      icon: Activity,
      label: 'Falsifiability',
      body: 'Falsifier conditions from prereg.yaml are evaluated against the curve so the brief reports what would change our mind.',
    },
  ];
  return (
    <div className="grid gap-2 border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          What this is
        </span>
        <span className="text-[11px] leading-relaxed text-foreground">
          The Hypothesis Workbench runs one question across a multiverse
          of defensible specifications (taxonomy × cohort × window), then
          shows where the answers converge and where they don&apos;t.
        </span>
        <a
          href="http://127.0.0.1:8765/"
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 border bg-background px-2 py-1 text-[10px] font-medium hover:bg-muted/50"
        >
          <ExternalLink className="h-3 w-3" />
          legacy FE (deprecated)
        </a>
      </div>
      <div className="grid gap-2 border-t pt-2 sm:grid-cols-2 lg:grid-cols-4">
        {uses.map((u) => (
          <div
            key={u.label}
            className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2"
          >
            <u.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="grid gap-0.5">
              <div className="text-[11px] font-semibold">{u.label}</div>
              <p className="text-[10.5px] leading-snug text-muted-foreground">
                {u.body}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PaneBar({
  pane,
  onPane,
  studySummary,
  studiesError,
}: {
  pane: PaneId;
  onPane: (p: PaneId) => void;
  studySummary: StudySummary | null;
  studiesError: string | null;
}) {
  return (
    <div className="grid gap-2 border bg-background p-2">
      <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-center">
        <div className="flex flex-wrap items-center gap-1">
          {PANES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPane(p.id)}
              className={cn(
                'grid grid-cols-[auto_minmax(0,1fr)] gap-2 px-2 py-1 text-left text-[11px] transition-colors',
                pane === p.id
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
              )}
              title={p.blurb}
            >
              <p.Icon className="mt-0.5 h-3.5 w-3.5 self-start" />
              <span className="grid gap-0">
                <span className="font-semibold">{p.label}</span>
                <span
                  className={cn(
                    'text-[9px]',
                    pane === p.id
                      ? 'text-background/70'
                      : 'text-muted-foreground/70',
                  )}
                >
                  {p.blurb}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {studySummary ? (
            <>
              <Badge variant="outline" className="font-mono text-[9px]">
                {studySummary.n_complete}/{studySummary.n_cells} cells
              </Badge>
              <Badge variant="outline" className="font-mono text-[9px]">
                {studySummary.n_error} errors
              </Badge>
              <Badge variant="outline" className="font-mono text-[9px]">
                {studySummary.status}
              </Badge>
            </>
          ) : (
            <Badge variant="outline" className="font-mono text-[9px]">
              no study selected
            </Badge>
          )}
          {studiesError ? (
            <Badge
              variant="outline"
              className="border-orange-500/40 font-mono text-[9px] text-orange-500"
              title={studiesError}
            >
              workbench offline
            </Badge>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PaneIntro({ pane }: { pane: PaneId }) {
  const intros: Record<PaneId, string> = {
    recipe:
      'Recipe & pre-registration — what the study was committed to before any data was generated. Axes, effective defaults, signed pre-registration, and the falsifier conditions the spec curve is currently evaluated against.',
    dag: 'The six declared assets in the research pipeline. Pick a cell from the rail below the diagram, then click any stage to inspect the per-stage AssetMaterialization receipt (partition key, model id, spend, sha-256 of inputs + outputs + prompt).',
    universe:
      'Each column is one cell of the multiverse (a defensible specification of the question). Each row is a clustered recommendation. Green = the cell agrees; orange = it flips; yellow = hedged; muted = the cell did not address it.',
    curve:
      'Clustered recommendations sorted by robustness, with per-cell vote glyphs. Cost histogram below uses cell.max_cost_usd from prereg to colour cap-hit cells orange.',
  };
  const label = PANES.find((p) => p.id === pane)?.label ?? '';
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 border-l-2 border-foreground/40 bg-muted/20 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <p className="min-w-0 break-words text-[11.5px] leading-relaxed text-foreground">
        {intros[pane]}
      </p>
    </div>
  );
}

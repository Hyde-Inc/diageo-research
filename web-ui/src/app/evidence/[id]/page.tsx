'use client';

/**
 * /evidence/[id] — one claim per page, linear vertical flow.
 *
 * The id maps to a spec-curve cluster_id. For the evidence chain we
 * use the highest-evidence agreeing cell as the canonical source so the
 * page can show real Dagster materialization stages from that cell.
 *
 * Layout, top to bottom:
 *   1. Claim          — the cluster's representative recommendation
 *   2. Source         — which cells voted "agree" (and which run we're
 *                       quoting from)
 *   3. Transformation — the stage chain that produced the brief, drawn
 *                       from `wb.materializations(run_id)`
 *   4. Output         — the robustness number + agreement counts
 */

import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Database,
  FileText,
  Layers,
  Quote,
} from 'lucide-react';
import { FocusCard, FocusPlaceholder, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  wb,
  type CellSummary,
  type Materialization,
  type SpecCurveRow,
} from '@/components/workbench/types';

export default function EvidencePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const data = useStudyData();
  const { curve, loadingCurve, studyId } = data;

  const row: SpecCurveRow | null = useMemo(() => {
    if (!curve) return null;
    return curve.rows.find((r) => String(r.cluster_id) === id) ?? null;
  }, [curve, id]);

  const cells = useMemo(() => curve?.cells ?? [], [curve]);
  const agreeingCells: CellSummary[] = useMemo(() => {
    if (!row) return [];
    return cells.filter((c) => row.statuses[c.id] === 'agree');
  }, [row, cells]);

  const sourceCell = useMemo<CellSummary | null>(() => {
    if (!row) return null;
    if (agreeingCells.length > 0) return agreeingCells[0];
    return cells.find((c) => row.statuses[c.id]) ?? null;
  }, [row, agreeingCells, cells]);

  // Keep mats keyed to the run_id we fetched for, so the loading flag
  // and contents stay aligned without a synchronous setState in the
  // effect (which the project's lint rules reject).
  const [matsFetch, setMatsFetch] = useState<{
    runId: string;
    mats: Materialization[] | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!sourceCell) return;
    let cancelled = false;
    const runId = sourceCell.run_id;
    wb.materializations(runId)
      .then((res) => {
        if (cancelled) return;
        setMatsFetch({ runId, mats: res.materializations, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setMatsFetch({
          runId,
          mats: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [sourceCell]);

  const currentRunId = sourceCell?.run_id ?? null;
  const mats =
    matsFetch && matsFetch.runId === currentRunId ? matsFetch.mats : null;
  const matsError =
    matsFetch && matsFetch.runId === currentRunId ? matsFetch.error : null;
  const matsLoading =
    currentRunId != null &&
    (matsFetch == null || matsFetch.runId !== currentRunId);

  return (
    <StudyShell
      data={data}
      eyebrow={`Evidence #${id}`}
      title="From claim to output number."
      intro="A linear walk from the recommendation back to the cells, the stages, and the robustness score."
      back={{
        href: row
          ? withStudy(`/scenario/${row.cluster_id}`, studyId)
          : withStudy('/scenario', studyId),
        label: 'Back to scenario',
      }}
    >
      {!studyId ? null : loadingCurve || !curve ? (
        <FocusCard tone="muted">
          <div className="grid gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-20 animate-pulse rounded-2xl bg-slate-200/70"
              />
            ))}
          </div>
        </FocusCard>
      ) : !row ? (
        <FocusCard>
          <p className="text-sm text-slate-600">
            No cluster <span className="font-mono">#{id}</span> on the
            current spec curve.
          </p>
        </FocusCard>
      ) : (
        <div className="grid gap-3">
          <Step
            number={1}
            label="Claim"
            Icon={Quote}
            tone="emerald"
          >
            <p className="text-balance text-base leading-relaxed text-slate-800">
              {row.representative}
            </p>
          </Step>

          <Connector />

          <Step
            number={2}
            label="Source"
            Icon={Database}
            tone="blue"
          >
            <SourceBody
              cells={agreeingCells}
              quotedCell={sourceCell}
              total={cells.length}
            />
          </Step>

          <Connector />

          <Step
            number={3}
            label="Transformation"
            Icon={Layers}
            tone="violet"
          >
            <TransformationBody
              mats={mats}
              loading={matsLoading}
              error={matsError}
              cell={sourceCell}
            />
          </Step>

          <Connector />

          <Step
            number={4}
            label="Output number"
            Icon={CheckCircle2}
            tone="amber"
          >
            <OutputBody row={row} totalCells={cells.length} />
          </Step>

          <FocusPlaceholder
            title="Per-claim citations are coming"
            body="Today we trace the claim back to a representative agreeing cell. The next iteration adds first-class citations (sentence-level pointers from the brief into source documents and tool calls), so we can quote the exact text the claim is based on."
          />

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Link
              href={withStudy(`/scenario/${row.cluster_id}`, studyId)}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 text-[12px] font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to scenario
            </Link>
            <Link
              href={withStudy('/answer', studyId)}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-slate-950 px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
            >
              Back to the answer
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      )}
    </StudyShell>
  );
}

function Step({
  number,
  label,
  Icon,
  tone,
  children,
}: {
  number: number;
  label: string;
  Icon: typeof Quote;
  tone: 'emerald' | 'blue' | 'violet' | 'amber';
  children: React.ReactNode;
}) {
  const cls = {
    emerald: 'border-emerald-200 bg-emerald-100 text-emerald-700',
    blue: 'border-blue-200 bg-blue-100 text-blue-700',
    violet: 'border-violet-200 bg-violet-100 text-violet-700',
    amber: 'border-amber-200 bg-amber-100 text-amber-700',
  }[tone];
  return (
    <FocusCard>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
        <div
          className={cn(
            'grid h-9 w-9 place-items-center rounded-xl border font-mono text-[10px] font-bold uppercase tabular-nums shadow-sm',
            cls,
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 grid gap-2">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Step {number}
            </span>
            <h3 className="text-sm font-semibold tracking-tight text-slate-900">
              {label}
            </h3>
          </div>
          <div>{children}</div>
        </div>
      </div>
    </FocusCard>
  );
}

function Connector() {
  return (
    <div className="grid place-items-center text-slate-300">
      <ArrowDown className="h-4 w-4" />
    </div>
  );
}

function SourceBody({
  cells,
  quotedCell,
  total,
}: {
  cells: CellSummary[];
  quotedCell: CellSummary | null;
  total: number;
}) {
  if (cells.length === 0) {
    return (
      <p className="text-[13px] text-slate-600">
        No cells voted &ldquo;agree&rdquo; for this scenario in the
        current curve. The claim is a candidate the synthesizer raised
        but no defensible framing has supported yet.
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <p className="text-[13px] leading-snug text-slate-700">
        {cells.length} of {total} cells produced a brief that supports
        this claim. We&apos;re quoting the run from{' '}
        {quotedCell ? (
          <span className="font-mono text-[11px] text-slate-900">
            {quotedCell.id}
          </span>
        ) : (
          'the lead cell'
        )}
        {quotedCell ? (
          <>
            {' '}
            (run{' '}
            <span className="font-mono text-[11px] text-slate-900">
              {quotedCell.run_id}
            </span>
            ).
          </>
        ) : (
          '.'
        )}
      </p>
      <ul className="grid gap-1.5">
        {cells.slice(0, 8).map((cell) => (
          <li
            key={cell.id}
            className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] shadow-sm"
          >
            {Object.entries(cell.axes).map(([axis, value]) => (
              <Badge
                key={axis}
                variant="outline"
                className="border-slate-200 bg-slate-50 font-mono text-[10px] text-slate-700"
              >
                <span className="text-slate-500">{axis}</span>
                <span className="mx-0.5 text-slate-400">·</span>
                {value}
              </Badge>
            ))}
            <span className="ml-auto font-mono text-[10px] text-slate-400">
              {cell.id}
            </span>
          </li>
        ))}
        {cells.length > 8 ? (
          <li className="text-[11px] text-slate-500">
            +{cells.length - 8} more
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function TransformationBody({
  mats,
  loading,
  error,
  cell,
}: {
  mats: Materialization[] | null;
  loading: boolean;
  error: string | null;
  cell: CellSummary | null;
}) {
  if (!cell) {
    return (
      <p className="text-[13px] text-slate-600">
        No source cell to draw a transformation chain from.
      </p>
    );
  }
  if (error) {
    return (
      <p className="text-[12px] text-orange-700">
        Couldn&apos;t load Dagster materializations: {error}
      </p>
    );
  }
  if (loading || !mats) {
    return (
      <div className="grid gap-1">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-10 animate-pulse rounded-xl bg-slate-200/70"
          />
        ))}
      </div>
    );
  }
  if (mats.length === 0) {
    return (
      <p className="text-[12px] text-slate-600">
        No <code className="font-mono text-[11px]">dagster_materializations.jsonl</code>{' '}
        on disk for this run yet — the runner writes one line per stage as
        it completes.
      </p>
    );
  }
  return (
    <ol className="grid gap-1.5">
      {mats.map((m, i) => (
        <li
          key={`${m.stage}-${i}`}
          className="flex flex-wrap items-baseline gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] shadow-sm"
        >
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            {String(i + 1).padStart(2, '0')}
          </span>
          <span className="font-mono text-[11px] font-semibold text-slate-900">
            {m.stage}
          </span>
          {m.model_id ? (
            <Badge
              variant="outline"
              className="border-slate-200 bg-slate-50 font-mono text-[9px] text-slate-600"
            >
              {m.model_id}
            </Badge>
          ) : null}
          {m.elapsed_s != null ? (
            <span className="font-mono text-[10px] text-slate-500">
              {m.elapsed_s.toFixed(1)}s
            </span>
          ) : null}
          {m.spent_usd != null ? (
            <span className="ml-auto font-mono text-[10px] text-slate-500">
              ${m.spent_usd.toFixed(4)}
            </span>
          ) : null}
        </li>
      ))}
      <li className="flex items-center gap-1 text-[10px] text-slate-500">
        <FileText className="h-3 w-3" />
        produces{' '}
        <code className="font-mono">runs/{cell.run_id}/final.md</code>
      </li>
    </ol>
  );
}

function OutputBody({
  row,
  totalCells,
}: {
  row: SpecCurveRow;
  totalCells: number;
}) {
  const pct = Math.round(row.robustness * 100);
  const total = row.n_agree + row.n_weaker + row.n_flips + row.n_missing;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-3xl font-bold leading-none tabular-nums text-slate-950">
          {pct}%
        </span>
        <span className="text-[13px] text-slate-600">
          robust · {row.n_agree}/{total} cells agree across{' '}
          {totalCells} defensible specifications
        </span>
      </div>
      <p className="text-[12px] leading-snug text-slate-500">
        Robustness is computed by the spec curve every time it&apos;s
        requested — there&apos;s no cached score on disk, so this number
        always reflects the current set of completed cells.
      </p>
    </div>
  );
}

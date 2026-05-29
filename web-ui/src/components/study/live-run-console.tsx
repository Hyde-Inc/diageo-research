'use client';

import { Activity, ChevronDown, ChevronUp, DollarSign } from 'lucide-react';
import { useMemo, useState } from 'react';
import { FocusCard } from '@/components/study/study-shell';
import { cn } from '@/lib/utils';
import type { StudyDetail } from '@/components/workbench/types';
import {
  useStudyStream,
  type StudyStreamState,
} from '@/components/study/use-study-stream';

const STAGE_ORDER = [
  'outline',
  'perspectives',
  'synthesis',
  'verifier',
  'charts',
  'final',
];

type Props = {
  studyId: string;
  /** Collapse when study is complete unless forced open. */
  defaultCollapsed?: boolean;
  study?: StudyDetail | null;
};

export function LiveRunConsole({
  studyId,
  defaultCollapsed = false,
  study: studyProp,
}: Props) {
  const stream = useStudyStream(studyId, true);
  const study = stream.study ?? studyProp ?? null;
  const cellCounts = useMemo(() => {
    const cells = study?.cells ?? [];
    return {
      complete: cells.filter((c) => c.status === 'complete').length,
      total: cells.length,
      errors: cells.filter((c) => c.status === 'error').length,
    };
  }, [study]);
  const running =
    study?.status === 'running' ||
    study?.status === 'pending' ||
    (study != null && cellCounts.complete < cellCounts.total);

  const [collapsed, setCollapsed] = useState(defaultCollapsed && !running);

  const progress =
    cellCounts.total > 0
      ? {
          complete: cellCounts.complete,
          total: cellCounts.total,
          errors: cellCounts.errors,
        }
      : null;

  if (!studyId) return null;

  return (
    <FocusCard tone={running ? 'default' : 'muted'}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity
            className={cn(
              'h-4 w-4',
              stream.connected && running
                ? 'animate-pulse text-emerald-600'
                : 'text-slate-400',
            )}
          />
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Live run
            </h3>
            {progress ? (
              <p className="text-sm font-medium text-slate-900">
                {progress.complete}/{progress.total} cells complete
                {progress.errors > 0 ? (
                  <span className="ml-1 text-rose-600">
                    · {progress.errors} error{progress.errors === 1 ? '' : 's'}
                  </span>
                ) : null}
              </p>
            ) : (
              <p className="text-sm text-slate-600">Waiting for study state…</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {stream.totalCostUsd > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700">
              <DollarSign className="h-3 w-3" />
              ${stream.totalCostUsd.toFixed(2)}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand live run console' : 'Collapse live run console'}
          >
            {collapsed ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </header>

      {collapsed ? null : (
        <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_minmax(0,280px)]">
          <CellProgressGrid study={study} stream={stream} />
          <StreamLog log={stream.log} error={stream.error} />
        </div>
      )}
    </FocusCard>
  );
}

function CellProgressGrid({
  study,
  stream,
}: {
  study: StudyDetail | null;
  stream: StudyStreamState;
}) {
  const cells = study?.cells ?? [];
  if (cells.length === 0) {
    return (
      <p className="text-[12px] text-slate-600">
        Cells will appear here once the multiverse launches.
      </p>
    );
  }

  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {cells.map((cell) => {
        const stages = stream.cellStages[cell.id] ?? {};
        const doneCount = STAGE_ORDER.filter(
          (s) => stages[s]?.status === 'complete',
        ).length;
        return (
          <li
            key={cell.id}
            className="rounded-xl border border-slate-200 bg-white p-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[11px] font-semibold text-slate-900">
                {cell.id.replace(/__/g, ' · ')}
              </span>
              <StatusPill status={cell.status} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {STAGE_ORDER.map((stage) => {
                const st = stages[stage]?.status ?? 'pending';
                return (
                  <span
                    key={stage}
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
                      st === 'complete' && 'bg-emerald-100 text-emerald-800',
                      st === 'running' && 'bg-sky-100 text-sky-800',
                      st === 'error' && 'bg-rose-100 text-rose-800',
                      st === 'pending' && 'bg-slate-100 text-slate-500',
                    )}
                  >
                    {stage.slice(0, 4)}
                  </span>
                );
              })}
            </div>
            <p className="mt-1 text-[10px] text-slate-500">
              {doneCount}/{STAGE_ORDER.length} stages
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'complete'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'running'
        ? 'bg-sky-100 text-sky-800'
        : status === 'error'
          ? 'bg-rose-100 text-rose-800'
          : 'bg-slate-100 text-slate-600';
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', tone)}>
      {status}
    </span>
  );
}

function StreamLog({
  log,
  error,
}: {
  log: StudyStreamState['log'];
  error: string | null;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-950 p-2.5 text-slate-100">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        Activity
      </p>
      {error ? (
        <p className="mt-1 text-[11px] text-rose-300">{error}</p>
      ) : null}
      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto font-mono text-[10px] leading-snug">
        {log.length === 0 ? (
          <li className="text-slate-500">Waiting for events…</li>
        ) : (
          log.map((line) => (
            <li key={line.id} className="text-slate-300">
              <span className="text-slate-500">
                {line.cellId ? `[${line.cellId}] ` : ''}
              </span>
              {line.message}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

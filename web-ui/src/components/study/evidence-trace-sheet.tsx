'use client';

import { useEffect, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { wb, type TraceResponse } from '@/components/workbench/types';

export function EvidenceTraceSheet({
  studyId,
  open,
  onOpenChange,
  traceId,
  clusterId,
  runId,
  metric,
  label,
}: {
  studyId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  traceId: string;
  clusterId?: number;
  runId?: string;
  metric?: string;
  label?: string;
}) {
  const fetchKey = open && studyId ? `${studyId}:${traceId}` : null;
  const [traceFetch, setTraceFetch] = useState<{
    key: string;
    trace: TraceResponse | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!fetchKey || !studyId) return;
    let cancelled = false;
    wb.trace(studyId, {
      trace_id: traceId,
      cluster_id: clusterId,
      run_id: runId,
      metric,
    })
      .then((t) => {
        if (!cancelled) setTraceFetch({ key: fetchKey, trace: t, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setTraceFetch({
            key: fetchKey,
            trace: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fetchKey, studyId, traceId, clusterId, runId, metric]);

  const trace =
    fetchKey && traceFetch?.key === fetchKey ? traceFetch.trace : null;
  const error =
    fetchKey && traceFetch?.key === fetchKey ? traceFetch.error : null;
  const loading = Boolean(fetchKey && traceFetch?.key !== fetchKey);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="text-left text-base">
            Evidence trace
          </SheetTitle>
          <SheetDescription className="text-left">
            {label ?? traceId} — source asset through transformation to output.
          </SheetDescription>
        </SheetHeader>
        {loading ? (
          <p className="mt-4 text-sm text-slate-500">Loading trace…</p>
        ) : error ? (
          <p className="mt-4 text-sm text-orange-700">{error}</p>
        ) : trace ? (
          <div className="mt-4 grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-2xl font-semibold tabular-nums text-slate-950">
                {trace.value_display}
              </span>
              {trace.illustrative ? (
                <Badge
                  variant="outline"
                  className="border-amber-200 bg-amber-50 text-[10px] uppercase tracking-wide text-amber-800"
                >
                  Illustrative
                </Badge>
              ) : null}
            </div>
            <ol className="grid gap-2 border-l-2 border-slate-200 pl-3">
              {trace.steps.map((step, idx) => (
                <li key={idx} className="grid gap-0.5">
                  <span
                    className={cn(
                      'text-[10px] font-semibold uppercase tracking-[0.16em]',
                      step.kind === 'source'
                        ? 'text-blue-600'
                        : step.kind === 'output'
                          ? 'text-emerald-600'
                          : 'text-slate-500',
                    )}
                  >
                    {step.kind}
                  </span>
                  <span className="text-sm font-medium text-slate-900">
                    {step.title}
                  </span>
                  <span className="text-[12px] leading-snug text-slate-600">
                    {step.detail}
                  </span>
                  {step.asset_ref ? (
                    <code className="text-[10px] text-slate-500">
                      {step.asset_ref}
                    </code>
                  ) : null}
                  {step.timestamp ? (
                    <span className="text-[10px] text-slate-400">
                      {step.timestamp}
                      {step.prompt_version
                        ? ` · prompt ${step.prompt_version.slice(0, 8)}`
                        : ''}
                      {step.code_version
                        ? ` · code ${step.code_version.slice(0, 8)}`
                        : ''}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

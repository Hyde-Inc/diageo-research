'use client';

/**
 * Cell detail sheet. Opens on the right when you click a cell card or
 * heatmap glyph. Reshaped for non-technical readers:
 *
 *   1. Top: status, axes (the cell's framing), elapsed time
 *   2. Brief snippet pulled from runs/<run_id>/final.md (first ~1.5kb)
 *   3. Spec-curve participation (where this cell agrees / disagrees)
 *   4. Materializations (the per-stage receipts, kept for power users)
 *   5. Lineage shortcut: "Open in lineage" jumps to the lineage pane
 *      with this cell still selected.
 */

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Database,
  FileText,
  GitGraph,
  Hash,
  Layers,
  Loader2,
  XCircle,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  wb,
  type CellRowStatus,
  type CellSummary,
  type Materialization,
  type RunFinal,
  type SpecCurveRow,
} from './types';

export type CellDetailContext = {
  cell: CellSummary;
  rows: SpecCurveRow[];
};

type MaterializationFetch = {
  runId: string;
  materializations: Materialization[] | null;
  error: string | null;
};

type FinalFetch = {
  runId: string;
  final: RunFinal | null;
  error: string | null;
};

export function CellDetailSheet({
  ctx,
  onClose,
  onOpenInLineage,
}: {
  ctx: CellDetailContext | null;
  onClose: () => void;
  onOpenInLineage?: (cellId: string) => void;
}) {
  const [matsFetch, setMatsFetch] = useState<MaterializationFetch | null>(null);
  const [finalFetch, setFinalFetch] = useState<FinalFetch | null>(null);
  const runId = ctx?.cell.run_id ?? null;

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    wb.materializations(runId)
      .then((res) => {
        if (cancelled) return;
        setMatsFetch({
          runId,
          materializations: res.materializations,
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setMatsFetch({
          runId,
          materializations: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    wb.runFinal(runId)
      .then((f) => {
        if (cancelled) return;
        setFinalFetch({ runId, final: f, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setFinalFetch({
          runId,
          final: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const currentMats = runId && matsFetch?.runId === runId ? matsFetch : null;
  const currentFinal = runId && finalFetch?.runId === runId ? finalFetch : null;
  const matsLoading = Boolean(runId && matsFetch?.runId !== runId);
  const finalLoading = Boolean(runId && finalFetch?.runId !== runId);

  return (
    <Sheet open={ctx !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full max-w-[680px] overflow-y-auto border-l border-slate-200 bg-slate-50"
      >
        {ctx ? (
          <CellDetailBody
            ctx={ctx}
            mats={currentMats?.materializations ?? null}
            matsError={currentMats?.error ?? null}
            matsLoading={matsLoading}
            final={currentFinal?.final ?? null}
            finalError={currentFinal?.error ?? null}
            finalLoading={finalLoading}
            onOpenInLineage={onOpenInLineage}
            onClose={onClose}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function CellDetailBody({
  ctx,
  mats,
  matsError,
  matsLoading,
  final,
  finalError,
  finalLoading,
  onOpenInLineage,
  onClose,
}: {
  ctx: CellDetailContext;
  mats: Materialization[] | null;
  matsError: string | null;
  matsLoading: boolean;
  final: RunFinal | null;
  finalError: string | null;
  finalLoading: boolean;
  onOpenInLineage?: (cellId: string) => void;
  onClose: () => void;
}) {
  const { cell, rows } = ctx;
  const axesEntries = Object.entries(cell.axes);

  const participantRows = rows
    .map((r) => ({ row: r, status: r.statuses[cell.id] }))
    .filter((x) => x.status !== undefined);

  return (
    <>
      <SheetHeader className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={cell.status} />
          <SheetTitle className="font-mono text-[13px]">{cell.id}</SheetTitle>
          {onOpenInLineage ? (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7 gap-1.5 rounded-full border-slate-200 bg-white px-2 text-[11px] shadow-sm hover:bg-slate-50"
              onClick={() => {
                onOpenInLineage(cell.id);
                onClose();
              }}
            >
              <GitGraph className="h-3 w-3" />
              Open in lineage
            </Button>
          ) : null}
        </div>
        <SheetDescription className="font-mono text-[10px]">
          run_id: {cell.run_id}
          {cell.elapsed_s != null
            ? `  ·  elapsed ${cell.elapsed_s.toFixed(1)}s`
            : ''}
        </SheetDescription>
      </SheetHeader>

      <section className="mt-4 grid gap-2">
        <SectionHeader icon={Layers} label="Assumptions (this cell\u2019s framing)" />
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {axesEntries.map(([axis, value]) => (
            <div
              key={axis}
              className="rounded-xl border border-slate-200 bg-white px-2 py-1.5 shadow-sm"
            >
              <div className="text-[9px] uppercase tracking-wider text-slate-500">
                {axis}
              </div>
              <div className="font-mono text-[11px] text-slate-800">{value}</div>
            </div>
          ))}
        </div>
      </section>

      {cell.error ? (
        <section className="mt-4 grid gap-2">
          <SectionHeader icon={AlertTriangle} label="Error" tone="warn" />
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-orange-200 bg-orange-50 p-2 font-mono text-[10px] text-orange-900">
            {cell.error}
          </pre>
        </section>
      ) : null}

      <section className="mt-4 grid gap-2">
        <SectionHeader icon={FileText} label="Brief snippet" />
        <BriefSnippet
          final={final}
          loading={finalLoading}
          error={finalError}
        />
      </section>

      <section className="mt-4 grid gap-2">
        <SectionHeader
          icon={CheckCircle2}
          label={`Spec-curve participation (${participantRows.length})`}
        />
        {participantRows.length === 0 ? (
          <EmptyHint>
            No spec-curve rows reference this cell yet. The curve gets
            rebuilt on every <code>GET /studies/{'{id}'}/spec_curve</code>.
          </EmptyHint>
        ) : (
          <div className="grid gap-1">
            {participantRows.slice(0, 12).map(({ row, status }) => (
              <div
                key={row.cluster_id}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-sm"
              >
                <RowStatusGlyph status={status} />
                <div className="min-w-0">
                  <div className="line-clamp-2 text-[11px] leading-snug">
                    {row.representative}
                  </div>
                  <div className="mt-1 font-mono text-[9px] text-slate-500">
                    cluster {row.cluster_id} · robustness{' '}
                    {(row.robustness * 100).toFixed(0)}%
                  </div>
                </div>
                <Badge variant="outline" className="font-mono text-[9px]">
                  {row.n_agree}/
                  {row.n_agree +
                    row.n_weaker +
                    row.n_flips +
                    row.n_missing}
                </Badge>
              </div>
            ))}
            {participantRows.length > 12 ? (
              <div className="px-1 text-[10px] text-slate-500">
                +{participantRows.length - 12} more rows
              </div>
            ) : null}
          </div>
        )}
      </section>

      <details className="mt-4 group rounded-xl border border-slate-200 bg-white shadow-sm">
        <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-[11px] text-slate-700">
          <Database className="h-3 w-3 text-slate-500" />
          <span className="font-semibold tracking-tight">
            Materializations ({mats?.length ?? 0})
          </span>
          <span className="text-slate-500">· per-stage receipts</span>
        </summary>
        <div className="border-t border-slate-100 p-2">
          {matsLoading ? (
            <EmptyHint>
              <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
              Loading <code>/runs/{cell.run_id}/materializations</code>
            </EmptyHint>
          ) : matsError ? (
            <EmptyHint tone="warn">{matsError}</EmptyHint>
          ) : !mats || mats.length === 0 ? (
            <EmptyHint>
              No <code>dagster_materializations.jsonl</code> on disk yet for
              this cell. The runner writes one line per stage as it
              completes.
            </EmptyHint>
          ) : (
            <div className="grid gap-1">
              {mats.map((m, idx) => (
                <MaterializationCard key={`${m.stage}-${idx}`} m={m} />
              ))}
            </div>
          )}
        </div>
      </details>
    </>
  );
}

function BriefSnippet({
  final,
  loading,
  error,
}: {
  final: RunFinal | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <EmptyHint>
        <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
        Loading brief…
      </EmptyHint>
    );
  }
  if (error) {
    return (
      <EmptyHint tone="warn">
        Couldn&apos;t load brief: {error}
      </EmptyHint>
    );
  }
  if (!final?.markdown) {
    return (
      <EmptyHint>
        No brief on disk yet. The synthesizer writes
        <code className="mx-1">final.md</code> when the cell completes.
      </EmptyHint>
    );
  }
  const trimmed = trimToFirstSection(final.markdown, 1400);
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <pre className="whitespace-pre-wrap font-sans text-[12px] leading-snug text-slate-800">
        {trimmed}
      </pre>
      {final.markdown.length > trimmed.length ? (
        <p className="mt-2 inline-flex items-center gap-1 text-[10px] text-slate-500">
          <span>Snippet only.</span>
          <span className="inline-flex items-center gap-0.5 font-mono">
            full brief at runs/{final.run_id}/final.md
            <ArrowRight className="h-3 w-3" />
          </span>
        </p>
      ) : null}
    </article>
  );
}

function trimToFirstSection(md: string, maxChars: number): string {
  const paragraphs = md.split(/\n{2,}/);
  let acc = '';
  for (const p of paragraphs) {
    if (acc.length + p.length + 2 > maxChars) {
      const remaining = maxChars - acc.length;
      if (remaining > 80) {
        acc = `${acc}\n\n${p.slice(0, remaining - 1)}…`;
      }
      break;
    }
    acc = acc ? `${acc}\n\n${p}` : p;
  }
  return acc.trim();
}

function MaterializationCard({ m }: { m: Materialization }) {
  return (
    <div className="grid gap-1 rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[9px]">
          {m.stage}
        </Badge>
        {m.model_id ? (
          <Badge variant="outline" className="font-mono text-[9px]">
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
      </div>
      <div className="font-mono text-[10px] text-slate-500">
        {new Date(m.timestamp).toLocaleString()}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px]">
        {m.input_hash ? <HashLine label="in" hash={m.input_hash} /> : null}
        {m.output_hash ? <HashLine label="out" hash={m.output_hash} /> : null}
        {m.prompt_hash ? <HashLine label="prompt" hash={m.prompt_hash} /> : null}
        {m.code_hash ? <HashLine label="code" hash={m.code_hash} /> : null}
      </div>
      <StageExtras m={m} />
    </div>
  );
}

function HashLine({ label, hash }: { label: string; hash: string }) {
  return (
    <span className="truncate">
      <Hash className="mr-1 inline h-2.5 w-2.5 text-slate-500" />
      <span className="text-slate-500">{label}:</span> {hash.slice(0, 12)}…
    </span>
  );
}

function StageExtras({ m }: { m: Materialization }) {
  const extras: string[] = [];
  if (m.complexity != null) extras.push(`complexity ${m.complexity}`);
  if (m.complexity_score != null) extras.push(`score ${m.complexity_score}`);
  if (m.recommended_personas != null)
    extras.push(`rec personas ${m.recommended_personas}`);
  if (m.n_personas != null) extras.push(`${m.n_personas} personas`);
  if (m.n_sections != null) extras.push(`${m.n_sections} sections`);
  if (m.n_subreports != null) extras.push(`${m.n_subreports} subreports`);
  if (m.total_citations != null) extras.push(`${m.total_citations} citations`);
  if (m.verified != null && m.flagged != null)
    extras.push(`${m.verified} verified · ${m.flagged} flagged`);
  if (m.markdown_len != null) extras.push(`${m.markdown_len} chars`);
  if (extras.length === 0) return null;
  return (
    <div className="font-mono text-[10px] text-slate-700">
      {extras.join(' · ')}
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  label,
  tone,
}: {
  icon: typeof Database;
  label: string;
  tone?: 'warn';
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider',
        tone === 'warn' ? 'text-orange-500' : 'text-slate-500',
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </div>
  );
}

function EmptyHint({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: 'warn';
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-slate-200 bg-white p-2 text-[11px] leading-snug shadow-sm',
        tone === 'warn'
          ? 'border-orange-200 bg-orange-50 text-orange-700'
          : 'text-slate-500',
      )}
    >
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: CellSummary['status'] }) {
  const map: Record<CellSummary['status'], { cls: string; label: string }> = {
    complete: {
      cls: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      label: 'complete',
    },
    running: {
      cls: 'border-blue-200 bg-blue-50 text-blue-700',
      label: 'running',
    },
    error: {
      cls: 'border-orange-200 bg-orange-50 text-orange-700',
      label: 'error',
    },
    pending: {
      cls: 'border-slate-200 bg-slate-50 text-slate-600',
      label: 'pending',
    },
  };
  const m = map[status];
  return (
    <Badge
      className={cn(
        'border font-mono text-[9px] uppercase shadow-sm',
        m.cls,
      )}
    >
      {m.label}
    </Badge>
  );
}

function RowStatusGlyph({ status }: { status: CellRowStatus }) {
  const cls = 'h-3 w-3 shrink-0';
  if (status === 'agree')
    return <CheckCircle2 className={cn(cls, 'text-emerald-500')} />;
  if (status === 'weaker')
    return <Clock className={cn(cls, 'text-yellow-500')} />;
  if (status === 'flips')
    return <XCircle className={cn(cls, 'text-orange-500')} />;
  return <div className={cn(cls, 'rounded-full bg-slate-300')} />;
}

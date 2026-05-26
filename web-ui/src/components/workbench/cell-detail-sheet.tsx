'use client';

/**
 * Cell detail sheet. Opens on the right when you click a heatmap cell
 * or a DAG node in the workbench. Shows:
 *
 *   - axes (taxonomy/cohort/window etc) and run_id
 *   - all spec-curve rows this cell participates in, with status glyph
 *   - per-stage AssetMaterialization receipts (the "real Dagster
 *     metadata" payload — partition_key, model, spend, hashes)
 *
 * Mirrors the EntityDetailSheet pattern from catalog-v2 so it reads
 * as a native Conduit drawer rather than a parallel design system.
 */

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
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
import { cn } from '@/lib/utils';
import {
  wb,
  type CellRowStatus,
  type CellSummary,
  type Materialization,
  type SpecCurveRow,
} from './types';

export type CellDetailContext = {
  cell: CellSummary;
  rows: SpecCurveRow[];
};

export function CellDetailSheet({
  ctx,
  onClose,
}: {
  ctx: CellDetailContext | null;
  onClose: () => void;
}) {
  const [mats, setMats] = useState<Materialization[] | null>(null);
  const [matsError, setMatsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!ctx) {
      setMats(null);
      setMatsError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setMatsError(null);
    wb.materializations(ctx.cell.run_id)
      .then((res) => {
        if (cancelled) return;
        setMats(res.materializations);
      })
      .catch((err) => {
        if (cancelled) return;
        setMatsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  return (
    <Sheet open={ctx !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full max-w-[640px] overflow-y-auto"
      >
        {ctx ? (
          <CellDetailBody
            ctx={ctx}
            mats={mats}
            matsError={matsError}
            loading={loading}
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
  loading,
}: {
  ctx: CellDetailContext;
  mats: Materialization[] | null;
  matsError: string | null;
  loading: boolean;
}) {
  const { cell, rows } = ctx;
  const axesEntries = Object.entries(cell.axes);

  const participantRows = rows
    .map((r) => ({ row: r, status: r.statuses[cell.id] }))
    .filter((x) => x.status !== undefined);

  return (
    <>
      <SheetHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={cell.status} />
          <SheetTitle className="font-mono text-[13px]">{cell.id}</SheetTitle>
        </div>
        <SheetDescription className="font-mono text-[10px]">
          run_id: {cell.run_id}
          {cell.elapsed_s != null
            ? `  ·  elapsed ${cell.elapsed_s.toFixed(1)}s`
            : ''}
        </SheetDescription>
      </SheetHeader>

      <section className="mt-4 grid gap-2">
        <SectionHeader icon={Layers} label="Axes" />
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {axesEntries.map(([axis, value]) => (
            <div key={axis} className="border bg-background px-2 py-1">
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                {axis}
              </div>
              <div className="font-mono text-[11px]">{value}</div>
            </div>
          ))}
        </div>
      </section>

      {cell.error ? (
        <section className="mt-4 grid gap-2">
          <SectionHeader icon={AlertTriangle} label="Error" tone="warn" />
          <pre className="overflow-x-auto whitespace-pre-wrap border bg-muted/30 p-2 font-mono text-[10px]">
            {cell.error}
          </pre>
        </section>
      ) : null}

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
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 border bg-background p-2"
              >
                <RowStatusGlyph status={status} />
                <div className="min-w-0">
                  <div className="line-clamp-2 text-[11px] leading-snug">
                    {row.representative}
                  </div>
                  <div className="mt-1 font-mono text-[9px] text-muted-foreground">
                    cluster {row.cluster_id} · robustness{' '}
                    {(row.robustness * 100).toFixed(0)}%
                  </div>
                </div>
                <Badge variant="outline" className="font-mono text-[9px]">
                  {row.n_agree}/{row.n_agree +
                    row.n_weaker +
                    row.n_flips +
                    row.n_missing}
                </Badge>
              </div>
            ))}
            {participantRows.length > 12 ? (
              <div className="px-1 text-[10px] text-muted-foreground">
                +{participantRows.length - 12} more rows
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section className="mt-4 grid gap-2">
        <SectionHeader
          icon={Database}
          label={`Materializations (${mats?.length ?? 0})`}
        />
        {loading ? (
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
      </section>
    </>
  );
}

function MaterializationCard({ m }: { m: Materialization }) {
  return (
    <div className="grid gap-1 border bg-background p-2">
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
          <span className="font-mono text-[10px] text-muted-foreground">
            {m.elapsed_s.toFixed(1)}s
          </span>
        ) : null}
        {m.spent_usd != null ? (
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            ${m.spent_usd.toFixed(4)}
          </span>
        ) : null}
      </div>
      <div className="font-mono text-[10px] text-muted-foreground">
        {new Date(m.timestamp).toLocaleString()}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px]">
        {m.input_hash ? (
          <HashLine label="in" hash={m.input_hash} />
        ) : null}
        {m.output_hash ? (
          <HashLine label="out" hash={m.output_hash} />
        ) : null}
        {m.prompt_hash ? (
          <HashLine label="prompt" hash={m.prompt_hash} />
        ) : null}
        {m.code_hash ? (
          <HashLine label="code" hash={m.code_hash} />
        ) : null}
      </div>
      <StageExtras m={m} />
    </div>
  );
}

function HashLine({ label, hash }: { label: string; hash: string }) {
  return (
    <span className="truncate">
      <Hash className="mr-1 inline h-2.5 w-2.5 text-muted-foreground" />
      <span className="text-muted-foreground">{label}:</span> {hash.slice(0, 12)}…
    </span>
  );
}

function StageExtras({ m }: { m: Materialization }) {
  const extras: string[] = [];
  if (m.complexity != null) extras.push(`complexity ${m.complexity}`);
  if (m.complexity_score != null)
    extras.push(`score ${m.complexity_score}`);
  if (m.recommended_personas != null)
    extras.push(`rec personas ${m.recommended_personas}`);
  if (m.n_personas != null) extras.push(`${m.n_personas} personas`);
  if (m.n_sections != null) extras.push(`${m.n_sections} sections`);
  if (m.n_subreports != null) extras.push(`${m.n_subreports} subreports`);
  if (m.total_citations != null)
    extras.push(`${m.total_citations} citations`);
  if (m.verified != null && m.flagged != null)
    extras.push(`${m.verified} verified · ${m.flagged} flagged`);
  if (m.markdown_len != null) extras.push(`${m.markdown_len} chars`);
  if (extras.length === 0) return null;
  return (
    <div className="font-mono text-[10px] text-foreground/70">
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
        tone === 'warn' ? 'text-orange-500' : 'text-muted-foreground',
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
        'border bg-muted/20 p-2 text-[11px] leading-snug',
        tone === 'warn' ? 'text-orange-500' : 'text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: CellSummary['status'] }) {
  const map: Record<CellSummary['status'], { cls: string; label: string }> = {
    complete: { cls: 'bg-green-500/15 text-green-500', label: 'complete' },
    running: { cls: 'bg-blue-500/15 text-blue-500', label: 'running' },
    error: { cls: 'bg-orange-500/15 text-orange-500', label: 'error' },
    pending: {
      cls: 'bg-muted text-muted-foreground',
      label: 'pending',
    },
  };
  const m = map[status];
  return (
    <Badge className={cn('font-mono text-[9px] uppercase', m.cls)}>
      {m.label}
    </Badge>
  );
}

function RowStatusGlyph({ status }: { status: CellRowStatus }) {
  const cls = 'h-3 w-3 shrink-0';
  if (status === 'agree')
    return <CheckCircle2 className={cn(cls, 'text-green-500')} />;
  if (status === 'weaker')
    return <Clock className={cn(cls, 'text-yellow-500')} />;
  if (status === 'flips')
    return <XCircle className={cn(cls, 'text-orange-500')} />;
  return <div className={cn(cls, 'rounded-full bg-muted-foreground/30')} />;
}

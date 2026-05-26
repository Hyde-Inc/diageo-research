'use client';

/**
 * /setup — what was actually run, in plain language.
 *
 * The page reads the study detail (cells + axes) and the prereg to
 * derive a single "We tested N versions of the same question, varying
 * X, Y, Z" sentence. Authors come from `prereg.signed_by`, status comes
 * from the spec curve rollup, and the raw config (spec/prereg paths)
 * lives at the bottom under a "Run info" disclosure so it doesn't
 * crowd the page.
 */

import { useMemo } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Clock,
  Loader2,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData } from '@/components/study/use-study';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type {
  CellDetail,
  StudyDetail,
} from '@/components/workbench/types';

export default function SetupPage() {
  const data = useStudyData();
  const { detail, prereg, studyId, loadingDetail } = data;
  const axes = useMemo(
    () => (detail ? indexAxes(detail.cells) : {}),
    [detail],
  );
  const totalSpecs = Object.values(axes).reduce(
    (acc, vs) => acc * Math.max(vs.length, 1),
    1,
  );

  return (
    <StudyShell
      data={data}
      eyebrow="Setup"
      title="What we ran."
      intro="A plain-language description of the study, who signed it off, and when. Raw config at the bottom."
    >
      {!studyId ? null : loadingDetail || !detail ? (
        <FocusCard tone="muted">
          <div className="grid gap-3">
            <div className="h-6 w-2/3 animate-pulse rounded-lg bg-slate-200" />
            <div className="h-4 w-1/2 animate-pulse rounded-full bg-slate-200" />
            <div className="h-4 w-1/3 animate-pulse rounded-full bg-slate-100" />
          </div>
        </FocusCard>
      ) : (
        <>
          <FocusCard>
            <div className="grid gap-3">
              <Badge
                variant="outline"
                className="w-fit border-slate-300 bg-white text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500"
              >
                Question
              </Badge>
              <p className="text-balance text-base leading-relaxed text-slate-800">
                {detail.question}
              </p>
              <p className="text-[14px] leading-relaxed text-slate-700">
                <strong>{detail.cells.length}</strong>{' '}
                {detail.cells.length === 1 ? 'version' : 'versions'} of the
                same question were tested,{' '}
                {axesSentence(axes, totalSpecs, detail.cells.length)}
              </p>
            </div>
          </FocusCard>

          <FocusCard>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Status & ownership
            </h3>
            <dl className="mt-2 grid gap-2 sm:grid-cols-2">
              <Field label="Status" value={<StatusValue detail={detail} />} />
              <Field
                label="Signed by"
                value={prereg?.signed_by ?? 'unsigned'}
                valueClassName={
                  prereg?.signed_by ? undefined : 'italic text-slate-400'
                }
              />
              <Field
                label="Signed at"
                value={prereg?.signed_at ? formatTs(prereg.signed_at) : '—'}
              />
              <Field label="Started" value={formatTs(detail.created_at)} />
              <Field label="Finished" value={formatTs(detail.finished_at)} />
              <Field
                label="Concurrency"
                value={
                  detail.concurrency != null ? `${detail.concurrency} parallel` : '—'
                }
              />
            </dl>
          </FocusCard>

          <FocusCard>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Decision rule
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-slate-700">
              {prereg?.decision_rule ??
                'No pre-registered decision rule on disk for this study.'}
            </p>
            {prereg?.falsifier_conditions &&
            prereg.falsifier_conditions.length > 0 ? (
              <p className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-slate-600">
                <ShieldAlert className="h-3.5 w-3.5 text-slate-400" />
                {prereg.falsifier_conditions.length} falsifier{' '}
                {prereg.falsifier_conditions.length === 1
                  ? 'condition'
                  : 'conditions'}{' '}
                pre-registered.
              </p>
            ) : null}
          </FocusCard>

          <details className="group overflow-hidden rounded-3xl border border-slate-200 bg-white/95 shadow-sm shadow-slate-950/[0.04]">
            <summary className="flex cursor-pointer select-none items-center gap-2 border-b border-transparent bg-slate-50/70 px-5 py-3 text-sm text-slate-700 group-open:border-slate-100">
              <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              <span className="font-semibold tracking-tight">Run info</span>
              <span className="text-[11px] text-slate-500">
                · raw paths and IDs
              </span>
            </summary>
            <dl className="grid gap-2 px-5 py-4 sm:grid-cols-2">
              <RawField label="Study ID" value={detail.id} mono />
              <RawField label="Name" value={detail.name} mono />
              {detail.spec_path ? (
                <RawField label="Spec path" value={detail.spec_path} mono />
              ) : null}
              {detail.prereg_path ? (
                <RawField label="Prereg path" value={detail.prereg_path} mono />
              ) : null}
              {prereg?.holdout_reservation ? (
                <RawField
                  label="Holdout reservation"
                  value={prereg.holdout_reservation}
                />
              ) : null}
              {prereg?.notes ? (
                <RawField label="Notes" value={prereg.notes} />
              ) : null}
            </dl>
          </details>
        </>
      )}
    </StudyShell>
  );
}

function StatusValue({ detail }: { detail: StudyDetail }) {
  const map: Record<StudyDetail['status'], { Icon: typeof CheckCircle2; cls: string }> = {
    complete: {
      Icon: CheckCircle2,
      cls: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    },
    running: {
      Icon: Loader2,
      cls: 'border-blue-200 bg-blue-50 text-blue-700',
    },
    error: {
      Icon: XCircle,
      cls: 'border-orange-200 bg-orange-50 text-orange-700',
    },
    pending: {
      Icon: Clock,
      cls: 'border-slate-200 bg-slate-50 text-slate-600',
    },
  };
  const m = map[detail.status];
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide shadow-sm',
        m.cls,
      )}
    >
      <m.Icon
        className={cn(
          'h-3 w-3',
          detail.status === 'running' && 'animate-spin',
        )}
      />
      {detail.status}
    </span>
  );
}

function Field({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="grid gap-0.5 rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </dt>
      <dd className={cn('text-[13px] text-slate-800', valueClassName)}>
        {value}
      </dd>
    </div>
  );
}

function RawField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid gap-0.5 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </dt>
      <dd
        className={cn(
          'truncate text-[12px] text-slate-700',
          mono && 'font-mono text-[11px]',
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function axesSentence(
  axes: Record<string, string[]>,
  totalSpecs: number,
  cells: number,
): string {
  const names = Object.keys(axes);
  if (names.length === 0) {
    return 'with no axes declared on the prereg.';
  }
  if (names.length === 1) {
    const [name] = names;
    return `varying ${name} (${axes[name].length} ${
      axes[name].length === 1 ? 'value' : 'values'
    }).`;
  }
  const list = names
    .map(
      (n) =>
        `${n} (${axes[n].length} ${
          axes[n].length === 1 ? 'value' : 'values'
        })`,
    )
    .join(', ');
  const note =
    totalSpecs !== cells
      ? ` That product is ${totalSpecs} specifications; ${cells} ran.`
      : '';
  return `varying ${list}.${note}`;
}

function formatTs(ts?: string | null): string {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

function indexAxes(cells: CellDetail[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const cell of cells) {
    for (const [name, value] of Object.entries(cell.axes ?? {})) {
      if (!out[name]) out[name] = [];
      if (!out[name].includes(value)) out[name].push(value);
    }
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

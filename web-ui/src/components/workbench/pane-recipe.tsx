'use client';

/**
 * Workbench Recipe pane.
 *
 * The "configurability" surface — what the study committed to *before*
 * any data was generated. The page header already shows the study
 * question and ID, so this pane focuses on:
 *   - Axes (the cartesian product that defines the multiverse)
 *   - Effective defaults (consistent overrides across every cell)
 *   - Pre-registration (decision rule, signed-by, evidence thresholds)
 *   - Falsifier conditions (with current curve evaluation)
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Shield } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  wb,
  type CellDetail,
  type Prereg,
  type SpecCurve,
  type StudyDetail,
} from './types';

type AxesIndex = Record<string, string[]>;
type PreregFetch = {
  studyId: string;
  prereg: Prereg | null;
  error: string | null;
};

function indexAxes(cells: CellDetail[]): AxesIndex {
  const out: AxesIndex = {};
  for (const cell of cells) {
    for (const [name, value] of Object.entries(cell.axes ?? {})) {
      if (!out[name]) out[name] = [];
      if (!out[name].includes(value)) out[name].push(value);
    }
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

/**
 * Collapse the per-cell `overrides` map to whatever is consistent
 * across every cell — this is what we can honestly call the
 * "effective" default for the study. Any key whose value disagrees
 * across cells gets dropped (we don't want to mislead stakeholders
 * about a default that doesn't exist).
 */
function effectiveDefaults(
  cells: CellDetail[],
): Record<string, unknown> | null {
  if (cells.length === 0) return null;
  const ovs = cells.map((c) => c.overrides ?? {});
  const allKeys = new Set<string>();
  for (const o of ovs) for (const k of Object.keys(o)) allKeys.add(k);
  const out: Record<string, unknown> = {};
  for (const k of allKeys) {
    const first = ovs[0][k];
    if (
      ovs.every(
        (o) => JSON.stringify(o[k] ?? null) === JSON.stringify(first ?? null),
      )
    ) {
      out[k] = first;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatTimestamp(ts?: string | null): string {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

// ─── Pane ──────────────────────────────────────────────────────────

export function PaneRecipe({
  studyId,
  detail,
  loadingDetail,
  curve,
  loading: curveLoading,
}: {
  studyId: string | null;
  detail: StudyDetail | null;
  loadingDetail: boolean;
  curve: SpecCurve | null;
  loading: boolean;
}) {
  const [preregFetch, setPreregFetch] = useState<PreregFetch | null>(null);

  useEffect(() => {
    if (!studyId) return;
    let cancelled = false;
    wb.prereg(studyId)
      .then((p) => {
        if (!cancelled) {
          setPreregFetch({ studyId, prereg: p, error: null });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPreregFetch({
            studyId,
            prereg: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  const currentPrereg =
    studyId && preregFetch?.studyId === studyId ? preregFetch : null;
  const prereg = currentPrereg?.prereg ?? null;
  const error = currentPrereg?.error ?? null;
  const loadingPrereg = Boolean(studyId && preregFetch?.studyId !== studyId);

  const axes = useMemo(
    () => (detail ? indexAxes(detail.cells) : {}),
    [detail],
  );
  const defaults = useMemo(
    () => (detail ? effectiveDefaults(detail.cells) : null),
    [detail],
  );

  if (!studyId) {
    return (
      <EmptyHint>Pick a study to see its recipe.</EmptyHint>
    );
  }
  if (loadingDetail || !detail) {
    return (
      <div className="grid place-items-center rounded-2xl border border-slate-200 bg-white/90 py-12 text-sm text-slate-500 shadow-sm">
        <Loader2 className="mb-2 h-4 w-4 animate-spin" />
        Loading recipe…
      </div>
    );
  }

  return (
    <div className="grid gap-4" data-testid="pane-recipe">
      <RecipeMeta detail={detail} />

      <Section
        title="Axes"
        meta={`${Object.keys(axes).length} ${
          Object.keys(axes).length === 1 ? 'axis' : 'axes'
        }`}
        hint="The cartesian product that defines the multiverse. The Universe pane shows one column per axis-tuple."
      >
        <AxesList axes={axes} />
      </Section>

      <Section
        title="Effective defaults"
        meta={defaults ? `${Object.keys(defaults).length} keys` : 'none'}
        hint="Per-cell config every cell agrees on. Surfaced from the consistent intersection of cell.overrides so we never claim a default that some cell actually changed."
      >
        <DefaultsList defaults={defaults} />
      </Section>

      <Section
        title="Pre-registration"
        meta={prereg?.signed_by ? `signed by ${prereg.signed_by}` : undefined}
        hint="Signed before the first cell ran. The synthesizer surfaces this rule in the final brief so the partner sees what the answer is being scored against."
      >
        {error ? (
          <p className="text-sm text-orange-500">
            Failed to load pre-registration: {error}
          </p>
        ) : loadingPrereg && !prereg ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <PreregBody prereg={prereg} />
        )}
      </Section>

      <Section
        title="Falsifier conditions"
        meta={
          curve
            ? `curve ${curve.falsifier_status.replace(/_/g, ' ')}`
            : curveLoading
              ? 're-evaluating…'
              : undefined
        }
        metaTone={falsifierTone(curve?.falsifier_status)}
        hint="Conditions that, if met, would invalidate the lead recommendation. The current spec curve's evaluation is shown alongside each condition."
      >
        <FalsifiersList prereg={prereg} curve={curve} />
      </Section>
    </div>
  );
}

// ─── Subject metadata ──────────────────────────────────────────────

function RecipeMeta({ detail }: { detail: StudyDetail }) {
  const parts: Array<[string, string]> = [['name', detail.name]];
  if (detail.spec_path) parts.push(['spec', detail.spec_path]);
  if (detail.prereg_path) parts.push(['prereg', detail.prereg_path]);
  return (
    <dl className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white/90 p-3 text-xs shadow-sm">
      {parts.map(([k, v]) => (
        <div
          key={k}
          className="flex min-w-0 items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1"
        >
          <dt className="font-semibold uppercase tracking-wide text-slate-500">{k}</dt>
          <dd className="truncate font-mono text-slate-700">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ─── Section primitive ─────────────────────────────────────────────

function Section({
  title,
  meta,
  metaTone,
  hint,
  children,
}: {
  title: string;
  meta?: string;
  metaTone?: 'good' | 'warn' | 'neutral';
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-sm shadow-slate-950/[0.04]">
      <header className="grid gap-1 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h3 className="text-sm font-semibold tracking-tight text-slate-900">
            {title}
          </h3>
          {meta ? (
            <span
              className={cn(
                'rounded-full border bg-white px-2 py-0.5 text-[11px] font-medium shadow-sm',
                metaTone === 'warn' && 'border-orange-200 text-orange-700',
                metaTone === 'good' && 'border-emerald-200 text-emerald-700',
                !metaTone && 'border-slate-200 text-slate-500',
              )}
            >
              {meta}
            </span>
          ) : null}
        </div>
        {hint ? (
          <p className="max-w-3xl text-xs text-slate-500">{hint}</p>
        ) : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function falsifierTone(
  status: SpecCurve['falsifier_status'] | undefined,
): 'good' | 'warn' | 'neutral' | undefined {
  if (!status) return undefined;
  if (status === 'fully_triggered') return 'warn';
  if (status === 'not_triggered') return 'good';
  return 'neutral';
}

// ─── Axes ──────────────────────────────────────────────────────────

function AxesList({ axes }: { axes: AxesIndex }) {
  const entries = Object.entries(axes);
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No axes declared for this study.
      </p>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {entries.map(([name, values]) => (
        <div key={name} className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {name}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {values.map((v) => (
              <span
                key={v}
                className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-1 font-mono text-xs text-slate-700 shadow-sm"
              >
                {v}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Defaults ──────────────────────────────────────────────────────

function DefaultsList({
  defaults,
}: {
  defaults: Record<string, unknown> | null;
}) {
  const entries = defaults ? Object.entries(defaults) : [];
  const order = [
    'n_personas',
    'max_turns',
    'max_cost_usd',
    'enable_web_browse',
    'max_browses_per_cell',
  ];
  entries.sort((a, b) => {
    const ai = order.indexOf(a[0]);
    const bi = order.indexOf(b[0]);
    if (ai === -1 && bi === -1) return a[0].localeCompare(b[0]);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No consistent overrides found — every cell sets at least one key
        differently. Compare per-cell overrides in the Universe pane.
      </p>
    );
  }
  return (
    <dl className="grid overflow-hidden rounded-xl border border-slate-200 sm:grid-cols-[max-content_1fr]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="border-b border-slate-100 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-500">
            {k}
          </dt>
          <dd className="border-b border-slate-100 px-3 py-2 font-mono text-xs text-slate-800">
            {formatValue(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ─── Pre-registration ──────────────────────────────────────────────

function PreregBody({ prereg }: { prereg: Prereg | null }) {
  if (!prereg) {
    return (
      <p className="text-sm text-muted-foreground">
        No prereg.yaml on disk for this study.
      </p>
    );
  }

  const rows: Array<[string, string]> = [
    ['decision_rule', prereg.decision_rule],
  ];
  if (prereg.signed_by) rows.push(['signed_by', prereg.signed_by]);
  if (prereg.signed_at) rows.push(['signed_at', formatTimestamp(prereg.signed_at)]);
  if (prereg.holdout_reservation) {
    rows.push(['holdout_reservation', prereg.holdout_reservation]);
  }
  if (prereg.notes) rows.push(['notes', prereg.notes]);

  const thresholds = prereg.evidence_thresholds ?? {};
  const thresholdEntries = Object.entries(thresholds);

  return (
    <div className="grid gap-4">
      <dl className="grid overflow-hidden rounded-xl border border-slate-200 sm:grid-cols-[max-content_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {k}
            </dt>
            <dd className="border-b border-slate-100 px-3 py-2 text-sm leading-snug text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>
      {thresholdEntries.length > 0 ? (
        <div className="grid gap-1.5">
          <div className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            evidence_thresholds
          </div>
          <div className="flex flex-wrap gap-1.5">
            {thresholdEntries.map(([k, v]) => (
              <Badge
                key={k}
                variant="outline"
                className="border-blue-200 bg-blue-50 font-mono text-xs text-blue-700"
              >
                {k} = {formatValue(v)}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Falsifiers ────────────────────────────────────────────────────

function FalsifiersList({
  prereg,
  curve,
}: {
  prereg: Prereg | null;
  curve: SpecCurve | null;
}) {
  const conditions = prereg?.falsifier_conditions ?? [];
  const overallStatus = curve?.falsifier_status ?? 'unknown';
  const notes = curve?.falsifier_notes ?? [];

  // The curve gives us aggregated notes, not per-condition triggers.
  // The backend's per-condition notes quote the first ~50 chars of the
  // condition itself. We only consider a match if a long enough
  // distinctive prefix of the condition appears in the note — otherwise
  // we'd accidentally cross-match conditions that share common words.
  const conditionToNote = (cond: string): string | null => {
    const key = cond.slice(0, 40).toLowerCase().replace(/\s+/g, ' ').trim();
    if (key.length < 20) return null;
    return notes.find((n) => n.toLowerCase().includes(key)) ?? null;
  };

  type CondStatus = 'triggered' | 'not_triggered' | 'unevaluated';
  const conditionStatus = (
    cond: string,
  ): { status: CondStatus; note: string | null } => {
    const note = conditionToNote(cond);
    if (note == null) {
      const fallback: CondStatus =
        overallStatus === 'fully_triggered'
          ? 'triggered'
          : overallStatus === 'not_triggered'
            ? 'not_triggered'
            : 'unevaluated';
      return { status: fallback, note: null };
    }
    const lc = note.toLowerCase();
    if (
      lc.includes('not auto-evaluated') ||
      lc.includes('requires bespoke') ||
      lc.includes('bespoke evaluation')
    ) {
      return { status: 'unevaluated', note };
    }
    if (lc.includes('not triggered')) {
      return { status: 'not_triggered', note };
    }
    return { status: 'triggered', note };
  };

  if (conditions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No falsifier conditions declared.
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      {conditions.map((cond, i) => {
        const { status, note } = conditionStatus(cond);
        const borderTone =
          status === 'triggered'
            ? 'border-orange-500/60'
            : status === 'unevaluated'
              ? 'border-yellow-500/40'
              : 'border-green-500/40';
        const iconTone =
          status === 'triggered'
            ? 'text-orange-500'
            : status === 'unevaluated'
              ? 'text-yellow-500'
              : 'text-green-500';
        const badgeTone =
          status === 'triggered'
            ? 'border-orange-500/60 text-orange-500'
            : status === 'unevaluated'
              ? 'border-yellow-500/60 text-yellow-500'
              : 'border-green-500/60 text-green-500';
        const badgeLabel =
          status === 'triggered'
            ? 'triggered'
            : status === 'unevaluated'
              ? 'requires bespoke check'
              : 'not triggered';
        return (
          <div
            key={i}
            className={cn(
              'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-xl border bg-white px-3 py-2.5 shadow-sm',
              borderTone,
            )}
          >
            <Shield className={cn('mt-0.5 h-4 w-4 shrink-0', iconTone)} />
            <div className="grid min-w-0 gap-1">
              <p className="text-sm leading-snug text-foreground">{cond}</p>
              {note ? (
                <p className="font-mono text-xs text-muted-foreground">{note}</p>
              ) : null}
            </div>
            <Badge
              variant="outline"
              className={cn('font-mono text-[10px] uppercase tracking-wide', badgeTone)}
            >
              {badgeLabel}
            </Badge>
          </div>
        );
      })}
      {prereg?.holdout_reservation ? (
        <p className="mt-1 text-xs text-muted-foreground">
          <span className="font-mono uppercase tracking-wide">holdout</span> — {prereg.holdout_reservation}
        </p>
      ) : null}
    </div>
  );
}

// ─── Misc ──────────────────────────────────────────────────────────

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white/80 p-4 text-sm text-slate-500 shadow-sm">
      {children}
    </div>
  );
}

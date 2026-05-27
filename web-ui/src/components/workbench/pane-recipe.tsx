'use client';

/**
 * Workbench Recipe pane.
 *
 * Reshaped for non-technical stakeholders: instead of a wall of axis
 * labels and prereg JSON, the pane reads top-down as a recipe card with
 * three blocks:
 *
 *   1. Knobs — the editable-feeling parameters (n_personas, max_turns,
 *      cost cap). Today they render as read-only inputs labelled
 *      "fixed" so the audience sees the affordance for change without
 *      us having to ship the mutation API in the same diff.
 *   2. Decision — the prereg's decision rule + falsifier conditions.
 *      Decision rule is the headline line; thresholds and falsifiers
 *      live in cards beneath, with the curve's live evaluation
 *      attached to each falsifier.
 *   3. Inputs — axes (the multiverse cartesian product) and full prereg
 *      details, both collapsed under disclosures so they don't crowd
 *      the page.
 */

import { useMemo } from 'react';
import {
  ChevronDown,
  Lock,
  Shield,
  Sliders,
  Target,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  type CellDetail,
  type Prereg,
  type SpecCurve,
  type StudyDetail,
} from './types';

type AxesIndex = Record<string, string[]>;

const KNOB_ORDER = [
  'n_personas',
  'max_turns',
  'max_cost_usd',
  'enable_web_browse',
  'max_browses_per_cell',
];

const KNOB_LABELS: Record<string, { label: string; hint: string }> = {
  n_personas: {
    label: 'Personas per cell',
    hint: 'How many synthetic analyst voices interview the question per cell.',
  },
  max_turns: {
    label: 'Turns per persona',
    hint: 'Maximum interviewer ↔ persona exchanges before the cell wraps.',
  },
  max_cost_usd: {
    label: 'Cost cap (USD)',
    hint: 'Hard ceiling on paid LLM calls — cells stop early if hit.',
  },
  enable_web_browse: {
    label: 'Web browsing',
    hint: 'Whether perspectives can launch a Chromium session for primary sources.',
  },
  max_browses_per_cell: {
    label: 'Max browses / cell',
    hint: 'Belt-and-braces cap on browse calls when web browsing is on.',
  },
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
 * across every cell — what we can honestly call the "effective" knob
 * setting for the study. Any key whose value disagrees gets dropped so
 * we never claim a default that some cell actually changed.
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
  if (typeof v === 'boolean') return v ? 'on' : 'off';
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
  prereg,
  curve,
  loading: curveLoading,
}: {
  studyId: string | null;
  detail: StudyDetail | null;
  loadingDetail: boolean;
  prereg: Prereg | null;
  curve: SpecCurve | null;
  loading: boolean;
}) {
  const axes = useMemo(
    () => (detail ? indexAxes(detail.cells) : {}),
    [detail],
  );
  const defaults = useMemo(
    () => (detail ? effectiveDefaults(detail.cells) : null),
    [detail],
  );

  if (!studyId) {
    return <EmptyHint>Pick a study to see its recipe.</EmptyHint>;
  }
  if (loadingDetail || !detail) {
    return (
      <div className="grid place-items-center rounded-2xl border border-slate-200 bg-white/90 py-12 text-sm text-slate-500 shadow-sm">
        Loading recipe…
      </div>
    );
  }

  const totalSpecs = Object.values(axes).reduce(
    (acc, vs) => acc * Math.max(vs.length, 1),
    1,
  );

  return (
    <div className="grid gap-4" data-testid="pane-recipe">
      <Section
        icon={Sliders}
        title="Knobs"
        subtitle="What was set for every cell. Locked icons mean the value is fixed for this run."
      >
        <KnobsGrid defaults={defaults} />
      </Section>

      <Section
        icon={Target}
        title="Decision"
        subtitle="The prereg statement the multiverse is being scored against, signed before any cell ran."
        meta={prereg?.signed_by ? `signed by ${prereg.signed_by}` : undefined}
      >
        <DecisionBlock prereg={prereg} curve={curve} curveLoading={curveLoading} />
      </Section>

      <Disclosure
        summary={`Inputs · ${Object.keys(axes).length} ${
          Object.keys(axes).length === 1 ? 'dimension' : 'dimensions'
        } → ${totalSpecs} cells`}
        hint="The cartesian product that defines the multiverse. Each combination produces one cell."
      >
        <AxesList axes={axes} />
      </Disclosure>

      <Disclosure
        summary="Pre-registration · full text"
        hint="Decision rule, evidence thresholds, holdout reservation, signing metadata. Frozen on disk."
      >
        <PreregFullBody prereg={prereg} />
      </Disclosure>
    </div>
  );
}

// ─── Knobs ─────────────────────────────────────────────────────────

function KnobsGrid({ defaults }: { defaults: Record<string, unknown> | null }) {
  const entries: Array<[string, unknown]> = defaults ? Object.entries(defaults) : [];
  entries.sort((a, b) => {
    const ai = KNOB_ORDER.indexOf(a[0]);
    const bi = KNOB_ORDER.indexOf(b[0]);
    if (ai === -1 && bi === -1) return a[0].localeCompare(b[0]);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  if (entries.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        Cells override at least one knob each — there&apos;s no shared
        default. Drill into a single cell from the Universe pane to see
        its overrides.
      </p>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {entries.map(([k, v]) => {
        const meta = KNOB_LABELS[k] ?? { label: k, hint: '' };
        return (
          <div
            key={k}
            className="grid gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-700">
                {meta.label}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                <Lock className="h-2.5 w-2.5" />
                fixed
              </span>
            </div>
            <KnobValue value={v} />
            {meta.hint ? (
              <p className="text-[11px] leading-snug text-slate-500">
                {meta.hint}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function KnobValue({ value }: { value: unknown }) {
  // Read-only "input" affordance — looks like a field, doesn't accept
  // input today. Switching to a real input is one prop away.
  const display = formatValue(value);
  if (typeof value === 'boolean') {
    return (
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'inline-flex h-5 w-9 items-center rounded-full border px-0.5 transition-colors',
            value ? 'justify-end bg-emerald-500/90 border-emerald-400' : 'justify-start bg-slate-200 border-slate-300',
          )}
          aria-hidden
        >
          <span className="h-3.5 w-3.5 rounded-full bg-white shadow-sm" />
        </span>
        <span className="font-mono text-[11px] text-slate-600">{display}</span>
      </div>
    );
  }
  return (
    <input
      type="text"
      value={display}
      readOnly
      tabIndex={-1}
      className="w-full cursor-default rounded-md border border-slate-200 bg-slate-50/90 px-2 py-1 font-mono text-[12px] text-slate-700 shadow-inner outline-none"
    />
  );
}

// ─── Decision ──────────────────────────────────────────────────────

function DecisionBlock({
  prereg,
  curve,
  curveLoading,
}: {
  prereg: Prereg | null;
  curve: SpecCurve | null;
  curveLoading: boolean;
}) {
  if (!prereg) {
    return (
      <p className="text-sm text-slate-500">
        No prereg.yaml on disk for this study. The runner refuses to
        start without one, so this only happens if the prereg was
        deleted post-run.
      </p>
    );
  }
  const thresholds = Object.entries(prereg.evidence_thresholds ?? {});
  return (
    <div className="grid gap-3">
      <div className="grid gap-1 rounded-2xl border border-blue-100 bg-blue-50/60 px-4 py-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-700">
          Decision rule
        </span>
        <p className="text-sm leading-snug text-slate-800">
          {prereg.decision_rule}
        </p>
      </div>
      {thresholds.length > 0 ? (
        <div className="grid gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Evidence thresholds
          </span>
          <div className="flex flex-wrap gap-1.5">
            {thresholds.map(([k, v]) => (
              <Badge
                key={k}
                variant="outline"
                className="border-blue-200 bg-blue-50 font-mono text-[11px] text-blue-700"
              >
                {k} ≥ {formatValue(v)}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      <FalsifiersList prereg={prereg} curve={curve} curveLoading={curveLoading} />
    </div>
  );
}

function FalsifiersList({
  prereg,
  curve,
  curveLoading,
}: {
  prereg: Prereg | null;
  curve: SpecCurve | null;
  curveLoading: boolean;
}) {
  const conditions = prereg?.falsifier_conditions ?? [];
  const overallStatus = curve?.falsifier_status ?? 'unknown';
  const notes = curve?.falsifier_notes ?? [];

  // Notes from the curve quote ~50 chars of the condition. We require a
  // long enough distinctive prefix before we'll cross-match a condition
  // to a note — otherwise common-words false-positives happen.
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
      lc.includes('bespoke evaluation') ||
      lc.includes('could not be evaluated') ||
      lc.includes('no spec-curve rows')
    ) {
      return { status: 'unevaluated', note };
    }
    if (lc.includes('not triggered')) {
      return { status: 'not_triggered', note };
    }
    return { status: 'triggered', note };
  };

  if (conditions.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Falsifier conditions ({conditions.length})
        </span>
        <span className="font-mono text-[10px] text-slate-500">
          curve:{' '}
          {curveLoading
            ? 're-evaluating…'
            : overallStatus.replace(/_/g, ' ')}
        </span>
      </div>
      {conditions.map((cond, i) => {
        const { status, note } = conditionStatus(cond);
        const borderTone =
          status === 'triggered'
            ? 'border-orange-300'
            : status === 'unevaluated'
              ? 'border-yellow-300'
              : 'border-emerald-200';
        const iconTone =
          status === 'triggered'
            ? 'text-orange-500'
            : status === 'unevaluated'
              ? 'text-yellow-500'
              : 'text-emerald-500';
        const badgeTone =
          status === 'triggered'
            ? 'border-orange-200 bg-orange-50 text-orange-700'
            : status === 'unevaluated'
              ? 'border-yellow-200 bg-yellow-50 text-yellow-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700';
        const badgeLabel =
          status === 'triggered'
            ? 'triggered'
            : status === 'unevaluated'
              ? 'un-evaluable'
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
              <p className="text-sm leading-snug text-slate-800">{cond}</p>
              {note ? (
                <p className="font-mono text-[11px] text-slate-500">{note}</p>
              ) : null}
            </div>
            <Badge variant="outline" className={cn('font-mono text-[10px] uppercase', badgeTone)}>
              {badgeLabel}
            </Badge>
          </div>
        );
      })}
      {prereg?.holdout_reservation ? (
        <p className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 text-[11px] text-slate-600">
          <span className="font-mono uppercase tracking-wider">holdout</span>{' '}
          — {prereg.holdout_reservation}
        </p>
      ) : null}
    </div>
  );
}

// ─── Inputs ────────────────────────────────────────────────────────

function AxesList({ axes }: { axes: AxesIndex }) {
  const entries = Object.entries(axes);
  if (entries.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No axes declared for this study.
      </p>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {entries.map(([name, values]) => (
        <div
          key={name}
          className="grid gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-700">{name}</span>
            <span className="font-mono text-[10px] text-slate-500">
              {values.length} {values.length === 1 ? 'value' : 'values'}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {values.map((v) => (
              <span
                key={v}
                className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[11px] text-slate-700"
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

function PreregFullBody({ prereg }: { prereg: Prereg | null }) {
  if (!prereg) {
    return (
      <p className="text-sm text-slate-500">No prereg.yaml on disk.</p>
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
  return (
    <dl className="grid gap-2 sm:grid-cols-[max-content_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="rounded-md bg-slate-50 px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            {k}
          </dt>
          <dd className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm leading-snug text-slate-800">
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ─── Section primitives ────────────────────────────────────────────

function Section({
  icon: Icon,
  title,
  subtitle,
  meta,
  children,
}: {
  icon: typeof Sliders;
  title: string;
  subtitle?: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-sm shadow-slate-950/[0.04]">
      <header className="grid gap-1 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-lg bg-slate-100 text-slate-600">
            <Icon className="h-3.5 w-3.5" />
          </span>
          <h3 className="text-sm font-semibold tracking-tight text-slate-900">
            {title}
          </h3>
          {meta ? (
            <span className="ml-auto rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500 shadow-sm">
              {meta}
            </span>
          ) : null}
        </div>
        {subtitle ? (
          <p className="max-w-3xl text-[11px] leading-snug text-slate-500">
            {subtitle}
          </p>
        ) : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Disclosure({
  summary,
  hint,
  children,
}: {
  summary: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-sm shadow-slate-950/[0.04]">
      <summary className="flex cursor-pointer select-none items-center gap-2 border-b border-transparent bg-slate-50/70 px-4 py-3 text-sm text-slate-700 group-open:border-slate-100">
        <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        <span className="font-semibold tracking-tight">{summary}</span>
        {hint ? (
          <span className="hidden text-[11px] text-slate-500 sm:inline">
            · {hint}
          </span>
        ) : null}
      </summary>
      <div className="p-4">{children}</div>
    </details>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white/80 p-4 text-sm text-slate-500 shadow-sm">
      {children}
    </div>
  );
}

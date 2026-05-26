'use client';

/**
 * Workbench Recipe pane.
 *
 * The "configurability" surface — what the study committed to *before*
 * any data was generated. This is the pane stakeholders should hit
 * first, because it grounds the rest of the workbench in the rule the
 * answer is being scored against, not just the answer.
 *
 * Data sources:
 *   - GET /studies/{id}            → question, name, cells (we derive
 *                                    axes from union of cell.axes and
 *                                    effective per-cell overrides).
 *   - GET /studies/{id}/prereg     → decision_rule, signed_by/at,
 *                                    falsifier_conditions, holdout,
 *                                    notes, evidence_thresholds.
 *   - GET /studies/{id}/spec_curve → falsifier_status, falsifier_notes
 *                                    (the evaluation of the prereg
 *                                    conditions against the current
 *                                    curve).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  FileSignature,
  GitBranch,
  Loader2,
  Settings2,
  Shield,
} from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  wb,
  type CellDetail,
  type Prereg,
  type SpecCurve,
  type StudyDetail,
} from './types';

type AxesIndex = Record<string, string[]>;

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
  curve,
  loading: curveLoading,
}: {
  studyId: string | null;
  curve: SpecCurve | null;
  loading: boolean;
}) {
  const [detail, setDetail] = useState<StudyDetail | null>(null);
  const [prereg, setPrereg] = useState<Prereg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!studyId) {
      setDetail(null);
      setPrereg(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([wb.study(studyId), wb.prereg(studyId)])
      .then(([d, p]) => {
        if (cancelled) return;
        setDetail(d);
        setPrereg(p);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studyId]);

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
      <div className="border bg-muted/10 p-6 text-[11px] text-muted-foreground">
        Pick a study to see its recipe.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="grid place-items-center border bg-muted/10 p-8 text-[11px] text-muted-foreground">
        <Loader2 className="mb-2 h-4 w-4 animate-spin" />
        Loading recipe…
      </div>
    );
  }
  if (error) {
    return (
      <div className="border bg-muted/20 p-4 text-[11px] text-orange-500">
        Failed to load recipe: {error}
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="border bg-muted/10 p-6 text-[11px] text-muted-foreground">
        No study detail available.
      </div>
    );
  }

  return (
    <div className="grid gap-3" data-testid="pane-recipe">
      <RecipeHeader detail={detail} />

      <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
        <AxesCard axes={axes} />
        <DefaultsCard defaults={defaults} />
      </div>

      <PreregCard prereg={prereg} />

      <FalsifiersCard prereg={prereg} curve={curve} curveLoading={curveLoading} />
    </div>
  );
}

// ─── Cards ─────────────────────────────────────────────────────────

function RecipeHeader({ detail }: { detail: StudyDetail }) {
  return (
    <Card className="rounded-none border bg-background shadow-none">
      <CardHeader className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recipe &amp; pre-registration
          </span>
          <Badge variant="outline" className="font-mono text-[9px]">
            {detail.id}
          </Badge>
          <Badge variant="outline" className="font-mono text-[9px]">
            {detail.cells.length} cells
          </Badge>
          <Badge variant="outline" className="font-mono text-[9px] uppercase">
            {detail.status}
          </Badge>
        </div>
        <CardTitle className="text-[15px] font-semibold leading-snug tracking-tight">
          {detail.question}
        </CardTitle>
        <CardDescription className="text-[11px]">
          What the study was committed to before any data was generated.
          The numbers in the other panes are scored against this recipe;
          nothing here was changed mid-flight.
        </CardDescription>
        <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-muted-foreground">
          <span>name: {detail.name}</span>
          {detail.created_at ? (
            <span>created {formatTimestamp(detail.created_at)}</span>
          ) : null}
          {detail.spec_path ? <span>spec: {detail.spec_path}</span> : null}
          {detail.prereg_path ? (
            <span>prereg: {detail.prereg_path}</span>
          ) : null}
        </div>
      </CardHeader>
    </Card>
  );
}

function AxesCard({ axes }: { axes: AxesIndex }) {
  const entries = Object.entries(axes);
  return (
    <Card className="rounded-none border bg-background shadow-none">
      <CardHeader className="space-y-1 p-4">
        <div className="flex items-center gap-2">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
          <CardTitle className="text-[11px] font-semibold uppercase tracking-wider">
            Axes
          </CardTitle>
          <Badge variant="outline" className="font-mono text-[9px]">
            {entries.length} axes
          </Badge>
        </div>
        <CardDescription className="text-[10.5px]">
          The cartesian product across these axes defines the
          multiverse. The Universe pane shows one column per axis-tuple.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 p-4 pt-0">
        {entries.length === 0 ? (
          <div className="text-[10.5px] text-muted-foreground">
            No axes declared for this study.
          </div>
        ) : (
          entries.map(([name, values]) => (
            <div key={name} className="grid gap-1 border-l-2 border-foreground/30 pl-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {name}
              </div>
              <div className="flex flex-wrap gap-1">
                {values.map((v) => (
                  <Badge
                    key={v}
                    variant="outline"
                    className="font-mono text-[10px]"
                  >
                    {v}
                  </Badge>
                ))}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function DefaultsCard({
  defaults,
}: {
  defaults: Record<string, unknown> | null;
}) {
  const entries = defaults ? Object.entries(defaults) : [];
  // Stable key order — put runner/budget-relevant keys first.
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
  return (
    <Card className="rounded-none border bg-background shadow-none">
      <CardHeader className="space-y-1 p-4">
        <div className="flex items-center gap-2">
          <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
          <CardTitle className="text-[11px] font-semibold uppercase tracking-wider">
            Effective defaults
          </CardTitle>
          <Badge variant="outline" className="font-mono text-[9px]">
            {entries.length} keys
          </Badge>
        </div>
        <CardDescription className="text-[10.5px]">
          The per-cell config that every cell agrees on. Surfaced from
          the consistent intersection of <code className="font-mono">cell.overrides</code>
          {' '}across the grid so we never claim a default that some
          cell actually changed.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {entries.length === 0 ? (
          <div className="px-4 pb-4 text-[10.5px] text-muted-foreground">
            No consistent overrides found — every cell sets at least one
            key differently. Compare per-cell overrides in the Universe
            pane.
          </div>
        ) : (
          <Table className="text-[11px]">
            <TableBody>
              {entries.map(([k, v]) => (
                <TableRow key={k} className="border-b last:border-b-0">
                  <TableCell className="w-[200px] px-4 py-1.5 font-mono text-[10.5px] text-muted-foreground">
                    {k}
                  </TableCell>
                  <TableCell className="px-4 py-1.5 font-mono text-[11px]">
                    {formatValue(v)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function PreregCard({ prereg }: { prereg: Prereg | null }) {
  if (!prereg) {
    return (
      <Card className="rounded-none border bg-background shadow-none">
        <CardHeader className="space-y-1 p-4">
          <div className="flex items-center gap-2">
            <FileSignature className="h-3.5 w-3.5 text-muted-foreground" />
            <CardTitle className="text-[11px] font-semibold uppercase tracking-wider">
              Pre-registration
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-0 text-[10.5px] text-muted-foreground">
          No prereg.yaml on disk for this study.
        </CardContent>
      </Card>
    );
  }

  const rows: Array<[string, string]> = [
    ['decision_rule', prereg.decision_rule],
    ['signed_by', prereg.signed_by ?? '—'],
    ['signed_at', formatTimestamp(prereg.signed_at)],
  ];
  if (prereg.holdout_reservation) {
    rows.push(['holdout_reservation', prereg.holdout_reservation]);
  }
  if (prereg.notes) rows.push(['notes', prereg.notes]);

  const thresholds = prereg.evidence_thresholds ?? {};
  const thresholdEntries = Object.entries(thresholds);

  return (
    <Card className="rounded-none border bg-background shadow-none">
      <CardHeader className="space-y-1 p-4">
        <div className="flex items-center gap-2">
          <FileSignature className="h-3.5 w-3.5 text-muted-foreground" />
          <CardTitle className="text-[11px] font-semibold uppercase tracking-wider">
            Pre-registration
          </CardTitle>
          {prereg.signed_by ? (
            <Badge variant="outline" className="font-mono text-[9px]">
              signed by {prereg.signed_by}
            </Badge>
          ) : null}
          {prereg.signed_at ? (
            <Badge variant="outline" className="font-mono text-[9px]">
              {formatTimestamp(prereg.signed_at)}
            </Badge>
          ) : null}
        </div>
        <CardDescription className="text-[10.5px]">
          Signed before the first cell ran. The synthesizer surfaces
          this rule in the final brief so the partner sees what the
          answer is being scored against, not just the answer.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 pt-0">
        <Table className="text-[11px]">
          <TableBody>
            {rows.map(([k, v]) => (
              <TableRow key={k} className="border-b last:border-b-0 align-top">
                <TableCell className="w-[200px] px-4 py-2 font-mono text-[10.5px] text-muted-foreground">
                  {k}
                </TableCell>
                <TableCell className="px-4 py-2 leading-snug">
                  {v}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {thresholdEntries.length > 0 ? (
          <div className="grid gap-1 border-t pt-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              evidence_thresholds
            </div>
            <div className="flex flex-wrap gap-1">
              {thresholdEntries.map(([k, v]) => (
                <Badge
                  key={k}
                  variant="outline"
                  className="font-mono text-[10px]"
                >
                  {k} = {formatValue(v)}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FalsifiersCard({
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

  // The curve gives us aggregated notes, not per-condition triggers.
  // The backend's per-condition notes quote the first ~50 chars of the
  // condition itself (e.g. `Falsifier 'Public-data elasticity ...'
  // requires bespoke evaluation`). We only consider a match if a long
  // enough distinctive prefix of the condition appears in the note —
  // otherwise we'd accidentally cross-match conditions that share
  // common words like "the recommended".
  const conditionToNote = (cond: string): string | null => {
    const key = cond.slice(0, 40).toLowerCase().replace(/\s+/g, ' ').trim();
    if (key.length < 20) return null;
    return notes.find((n) => n.toLowerCase().includes(key)) ?? null;
  };

  // Per-condition trichotomy derived from the curve's aggregate notes:
  // triggered  — the curve says this condition fired
  // unevaluated — backend explicitly says the condition isn't checked
  //   (e.g. external elasticity sign requires bespoke evaluation)
  // not_triggered — the default once we've matched a note that says so
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

  return (
    <Card className="rounded-none border bg-background shadow-none">
      <CardHeader className="space-y-1 p-4">
        <div className="flex items-center gap-2">
          <Shield className="h-3.5 w-3.5 text-muted-foreground" />
          <CardTitle className="text-[11px] font-semibold uppercase tracking-wider">
            Falsifier conditions
          </CardTitle>
          <Badge
            variant="outline"
            className={cn(
              'font-mono text-[9px] uppercase',
              overallStatus === 'fully_triggered' &&
                'border-orange-500/60 text-orange-500',
              overallStatus === 'partially_triggered' &&
                'border-yellow-500/60 text-yellow-500',
              overallStatus === 'not_triggered' &&
                'border-green-500/60 text-green-500',
            )}
          >
            curve {overallStatus.replace(/_/g, ' ')}
          </Badge>
          {curveLoading ? (
            <span className="font-mono text-[9px] text-muted-foreground">
              re-evaluating…
            </span>
          ) : null}
        </div>
        <CardDescription className="text-[10.5px]">
          Conditions that, if met, would invalidate the lead
          recommendation. The current spec curve&apos;s evaluation is
          shown alongside each condition.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 p-4 pt-0">
        {conditions.length === 0 ? (
          <div className="text-[10.5px] text-muted-foreground">
            No falsifier conditions declared.
          </div>
        ) : (
          conditions.map((cond, i) => {
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
                  'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-l-2 bg-background px-3 py-2',
                  borderTone,
                )}
              >
                <Shield className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', iconTone)} />
                <div className="min-w-0 grid gap-1">
                  <div className="text-[11px] leading-snug">{cond}</div>
                  {note ? (
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {note}
                    </div>
                  ) : null}
                </div>
                <Badge
                  variant="outline"
                  className={cn('font-mono text-[9px] uppercase', badgeTone)}
                >
                  {badgeLabel}
                </Badge>
              </div>
            );
          })
        )}
        {prereg?.holdout_reservation ? (
          <div className="mt-1 border-t pt-2 text-[10.5px] text-muted-foreground">
            <span className="font-mono uppercase tracking-wider">
              holdout
            </span>{' '}
            — {prereg.holdout_reservation}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

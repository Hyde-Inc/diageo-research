'use client';

/**
 * /why-it-could-be-wrong — what would prove us wrong in plain English.
 *
 * Each prereg falsifier becomes one card with a current-state pill:
 *   not triggered / borderline / triggered / requires bespoke check
 *
 * The cell-detail-style cross-match (curve.falsifier_notes ↔ a
 * particular condition) mirrors the workbench Recipe pane so the
 * audience sees the same status whichever surface they land on.
 */

import { useMemo } from 'react';
import { CheckCircle2, ShieldAlert, Sparkles, XCircle } from 'lucide-react';
import { ConfidencePanel } from '@/components/study/confidence-panel';
import { FocusCard, FocusPlaceholder, StudyShell } from '@/components/study/study-shell';
import { useStudyData } from '@/components/study/use-study';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Prereg, SpecCurve } from '@/components/workbench/types';

type CondState = 'not_triggered' | 'borderline' | 'triggered' | 'bespoke';

type Item = {
  text: string;
  state: CondState;
  note: string | null;
};

export default function WhyItCouldBeWrongPage() {
  const data = useStudyData();
  const { curve, prereg, loadingPrereg, loadingCurve, studyId } = data;
  const items = useMemo(() => buildItems(prereg, curve), [prereg, curve]);

  return (
    <StudyShell
      data={data}
      eyebrow="Why it could be wrong"
      title="What would prove us wrong?"
      intro="Pre-registered conditions that would overturn or weaken the study, tied back to the same confidence checks."
    >
      {!studyId ? null : loadingPrereg || loadingCurve ? (
        <FocusCard tone="muted">
          <div className="grid gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-16 animate-pulse rounded-xl bg-slate-200/70"
              />
            ))}
          </div>
        </FocusCard>
      ) : !prereg ? (
        <FocusCard>
          <p className="text-sm text-slate-600">
            No pre-registration on disk — the runner refuses to start
            without one, so this only happens if the prereg was deleted
            after the run.
          </p>
        </FocusCard>
      ) : items.length === 0 ? (
        <FocusPlaceholder
          title="No conditions registered"
          body="This study did not pre-register what would prove it wrong. Flag this before treating the answer as decision-grade."
        />
      ) : (
        <>
          <FocusCard>
            <a
              href="#confidence-panel"
              className="mb-3 inline-flex text-[12px] font-medium text-slate-700 underline-offset-4 hover:underline"
            >
              See how these conditions affect confidence
            </a>
            <div className="grid gap-2">
              {items.map((item, idx) => (
                <FalsifierCard key={idx} item={item} />
              ))}
            </div>
          </FocusCard>
          <Recap curve={curve} />
          <ConfidencePanel
            curve={curve}
            prereg={prereg}
            interval={{
              kind: 'confidence interval',
              available: false,
              requiredData:
                'observed outcomes or holdout data that can test the pre-registered wrong-way conditions.',
            }}
            provenance={{
              source: 'Pre-registered wrong-way conditions and spec curve notes',
              transformation: 'Condition matching against current scenario evidence',
              output: 'Status for each condition that would prove us wrong',
              available: true,
            }}
            raiseConfidence={[
              'Turn every wrong-way condition into a measurable threshold before the next run.',
              'Connect outcome data so triggered and borderline conditions can be tested statistically.',
              'Review the confidence panel whenever a condition moves from not triggered to borderline or triggered.',
            ]}
          />
        </>
      )}
    </StudyShell>
  );
}

function FalsifierCard({ item }: { item: Item }) {
  const tone = TONE[item.state];
  return (
    <article
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-2xl border p-4 shadow-sm',
        tone.borderClass,
      )}
    >
      <div
        className={cn(
          'mt-0.5 grid h-7 w-7 place-items-center rounded-lg',
          tone.iconBg,
        )}
      >
        <tone.Icon className={cn('h-3.5 w-3.5', tone.iconColor)} />
      </div>
      <div className="grid min-w-0 gap-1.5">
        <p className="text-[14px] leading-snug text-slate-800">{item.text}</p>
        {item.note ? (
          <p className="text-[11px] leading-snug text-slate-500">
            <span className="font-mono uppercase tracking-wider">
              evidence
            </span>{' '}
            · {item.note}
          </p>
        ) : null}
      </div>
      <Badge
        variant="outline"
        className={cn(
          'shrink-0 font-mono text-[10px] uppercase tracking-wider',
          tone.badgeClass,
        )}
      >
        {tone.label}
      </Badge>
    </article>
  );
}

function Recap({ curve }: { curve: SpecCurve | null }) {
  if (!curve) return null;
  const status = curve.falsifier_status;
  const label =
    status === 'fully_triggered'
      ? 'A condition that would prove us wrong triggered. Treat the answer as overturned until reviewed.'
      : status === 'partially_triggered'
        ? 'Some conditions that would prove us wrong are borderline. The answer is conditional on bespoke checks.'
        : status === 'not_triggered'
          ? 'No condition that would prove us wrong triggered against the current scenarios.'
          : 'Wrong-way condition evaluation is pending — the curve has not produced enough evidence yet.';
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-[12px] leading-snug text-slate-600 shadow-sm">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        Overall
      </span>{' '}
      · {label}
    </div>
  );
}

const TONE: Record<CondState, {
  Icon: typeof ShieldAlert;
  label: string;
  borderClass: string;
  iconBg: string;
  iconColor: string;
  badgeClass: string;
}> = {
  not_triggered: {
    Icon: CheckCircle2,
    label: 'not triggered',
    borderClass: 'border-emerald-200 bg-emerald-50/60',
    iconBg: 'bg-emerald-100',
    iconColor: 'text-emerald-600',
    badgeClass: 'border-emerald-200 bg-white text-emerald-700',
  },
  borderline: {
    Icon: ShieldAlert,
    label: 'borderline',
    borderClass: 'border-yellow-300 bg-yellow-50/70',
    iconBg: 'bg-yellow-100',
    iconColor: 'text-yellow-700',
    badgeClass: 'border-yellow-200 bg-white text-yellow-700',
  },
  triggered: {
    Icon: XCircle,
    label: 'triggered',
    borderClass: 'border-orange-300 bg-orange-50/70',
    iconBg: 'bg-orange-100',
    iconColor: 'text-orange-600',
    badgeClass: 'border-orange-200 bg-white text-orange-700',
  },
  bespoke: {
    Icon: Sparkles,
    label: 'requires bespoke check',
    borderClass: 'border-slate-200 bg-slate-50/70',
    iconBg: 'bg-slate-100',
    iconColor: 'text-slate-500',
    badgeClass: 'border-slate-200 bg-white text-slate-600',
  },
};

function buildItems(prereg: Prereg | null, curve: SpecCurve | null): Item[] {
  const conditions = prereg?.falsifier_conditions ?? [];
  if (conditions.length === 0) return [];

  const overall = curve?.falsifier_status ?? 'unknown';
  const notes = curve?.falsifier_notes ?? [];
  const thresholds = prereg?.evidence_thresholds ?? {};

  return conditions.map((cond) => {
    const matched = matchThreshold(cond, thresholds);
    const whatDataTests = describeDataTest(cond);
    const base = {
      text: cond,
      thresholdLabel: matched?.label ?? null,
      thresholdValue: matched?.value ?? null,
      whatDataTests,
    };
    const note = matchNote(cond, notes);
    if (note == null) {
      const fallback: CondState =
        overall === 'fully_triggered'
          ? 'triggered'
          : overall === 'partially_triggered'
            ? 'borderline'
            : overall === 'not_triggered'
              ? 'not_triggered'
              : 'bespoke';
      return { ...base, state: fallback, note: null };
    }
    const lc = note.toLowerCase();
    if (
      lc.includes('not auto-evaluated') ||
      lc.includes('requires bespoke') ||
      lc.includes('bespoke evaluation')
    ) {
      return { ...base, state: 'bespoke', note };
    }
    if (lc.includes('borderline')) {
      return { ...base, state: 'borderline', note };
    }
    if (lc.includes('not triggered')) {
      return { ...base, state: 'not_triggered', note };
    }
    return { ...base, state: 'triggered', note };
  });
}

function matchThreshold(
  cond: string,
  thresholds: Record<string, number | string | null>,
): { label: string; value: string } | null {
  const lc = cond.toLowerCase();
  for (const [key, raw] of Object.entries(thresholds)) {
    if (raw == null) continue;
    const tokens = key
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (tokens.length === 0) continue;
    const hit = tokens.every((t) => lc.includes(t));
    if (!hit) continue;
    const value = typeof raw === 'number' ? formatNumber(raw, key) : String(raw);
    return { label: humaniseKey(key), value };
  }
  return null;
}

function formatNumber(value: number, key: string): string {
  const lc = key.toLowerCase();
  if (lc.includes('pct') || lc.includes('percent') || lc.includes('share')) {
    return `${value.toFixed(value < 1 ? 2 : 1)}%`;
  }
  if (lc.includes('usd') || lc.includes('cost') || lc.includes('spend')) {
    return `$${value.toLocaleString()}`;
  }
  if (lc.includes('weeks') || lc.includes('days') || lc.includes('months')) {
    return `${value}`;
  }
  return String(value);
}

function humaniseKey(key: string): string {
  return key.replace(/_/g, ' ');
}

function describeDataTest(cond: string): string {
  const lc = cond.toLowerCase();
  if (lc.includes('holdout') || lc.includes('hold-out')) {
    return 'A reserved holdout group with matched audiences and timing.';
  }
  if (lc.includes('promo') || lc.includes('discount')) {
    return 'Connected promotion or discount outcome data for the exposed brand and occasion.';
  }
  if (lc.includes('loyalty') || lc.includes('panel')) {
    return 'Loyalty panel cohort flows over the question window.';
  }
  if (lc.includes('elasticity') || lc.includes('price sensitivity')) {
    return 'Observed price-volume movements with at least two price points in the window.';
  }
  if (lc.includes('occasion') || lc.includes('audience') || lc.includes('cohort')) {
    return 'Occasion or audience mix observations for the same population segment.';
  }
  if (lc.includes('regulator') || lc.includes('compliance')) {
    return 'A sign-off from a named legal or compliance reviewer.';
  }
  return 'Plain outcome data tied to the exposed segment and the agreed measurement window.';
}

function matchNote(cond: string, notes: string[]): string | null {
  // Match the same way the Recipe pane does — first 40 chars after
  // whitespace normalisation. Anything shorter is too risky to match.
  const key = cond.slice(0, 40).toLowerCase().replace(/\s+/g, ' ').trim();
  if (key.length < 20) return null;
  return notes.find((n) => n.toLowerCase().includes(key)) ?? null;
}

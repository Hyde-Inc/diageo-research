'use client';

/**
 * /answer — the executive answer for the active study.
 *
 * Header H1 = the full study question (rendered by StudyShell).
 *
 * Main column: 1–2 sentence recommendation, one explicit confidence
 * sentence, and the standard ConfidencePanel below.
 *
 * Right rail: a single primary action ("Take to MBP" by default,
 * "Stress-test the answer" when the lead is fragile) plus secondary
 * actions ("Ask a follow-up", "See evidence", "Stress-test" if MBP is
 * the primary). The "What this is and isn't" tooltip is a small icon
 * button next to the primary action, not a paragraph.
 */

import Link from 'next/link';
import { useState } from 'react';
import {
  ArrowRight,
  Compass,
  HelpCircle,
  MessageCircle,
  TrendingUp,
} from 'lucide-react';
import { ConfidencePanel } from '@/components/study/confidence-panel';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData, withStudy } from '@/components/study/use-study';
import { cn } from '@/lib/utils';
import type { SpecCurve, SpecCurveRow } from '@/components/workbench/types';

// The growth-driver page is always available in this build. Flip to a
// runtime flag if/when MBP-readiness becomes a study-level property.
const GROWTH_DRIVER_AVAILABLE = true;

export default function AnswerPage() {
  const data = useStudyData();
  const { detail, curve, loadingCurve, loadingDetail, prereg, studyId } = data;
  const lead = curve?.rows[0] ?? null;
  const question = detail?.question?.trim() || curve?.question?.trim() || '';

  return (
    <StudyShell
      data={data}
      eyebrow="Executive answer"
      title={question || 'No question registered for this study'}
      contentClassName="max-w-[1400px]"
      mainLabel="Answer"
      rightLabel="Next actions"
      main={
        !studyId ? null : loadingDetail || loadingCurve ? (
          <FocusCard tone="muted">
            <div className="grid gap-3">
              <p className="text-[11px] italic leading-snug text-slate-500">
                Loading the executive answer…
              </p>
              <div className="h-7 w-3/4 animate-pulse rounded-lg bg-slate-200" />
              <div className="h-4 w-1/2 animate-pulse rounded-full bg-slate-200" />
              <div className="h-4 w-2/3 animate-pulse rounded-full bg-slate-100" />
            </div>
          </FocusCard>
        ) : !curve || !lead ? (
          <NoAnswerYet studyId={studyId} />
        ) : (
          <div className="grid gap-4">
            <FocusCard>
              <div className="grid gap-4">
                <Recommendation lead={lead} />
                <ConfidenceSentence curve={curve} lead={lead} />
              </div>
            </FocusCard>
            <ConfidencePanel
              curve={curve}
              prereg={prereg}
              interval={{
                kind: 'confidence interval',
                available: false,
                requiredData:
                  'observed outcome data or a holdout sample tied to the agreed decision rule.',
              }}
              provenance={{
                source:
                  'Study pre-registration, scenario outputs, and evidence traces',
                transformation:
                  'Recommendation clustering and robustness scoring',
                output: 'Executive answer plus caveats',
                available: true,
              }}
              raiseConfidence={[
                'Attach observed outcome data so the answer can carry a real confidence interval.',
                'Review any scenario framings where the recommendation weakens or flips.',
                'Validate that the conditions that would prove us wrong are still acceptable to stakeholders.',
              ]}
            />
          </div>
        )
      }
      right={
        !studyId || !curve || !lead ? null : (
          <ActionRail studyId={studyId} curve={curve} />
        )
      }
    />
  );
}

function NoAnswerYet({ studyId }: { studyId: string | null }) {
  return (
    <FocusCard>
      <p className="text-sm leading-snug text-slate-600">
        No clustered recommendations yet — either the study is still running
        or no scenario produced a brief. Check{' '}
        <Link
          href={withStudy('/setup', studyId)}
          className="font-medium text-slate-900 underline-offset-4 hover:underline"
        >
          Setup
        </Link>{' '}
        for status.
      </p>
    </FocusCard>
  );
}

function Recommendation({ lead }: { lead: SpecCurveRow }) {
  const cleaned = cleanRepresentative(lead.representative);
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const body = sentences.slice(0, 2).join(' ') || cleaned;
  return (
    <p className="text-balance text-xl font-medium leading-snug tracking-tight text-slate-950 md:text-[22px]">
      {body}
    </p>
  );
}

function cleanRepresentative(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  const cutMatch = trimmed.search(/##\s*Pre-?registration|##\s+/i);
  const sliced = cutMatch >= 0 ? trimmed.slice(0, cutMatch) : trimmed;
  return sliced
    .replace(/\*\*/g, '')
    .replace(/_+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function ConfidenceSentence({
  curve,
  lead,
}: {
  curve: SpecCurve;
  lead: SpecCurveRow;
}) {
  const total = lead.n_agree + lead.n_weaker + lead.n_flips + lead.n_missing;
  const holds = lead.n_agree;
  const flips = lead.n_flips;
  const weaker = lead.n_weaker;
  const fragile = lead.fragile_specs;
  const tone =
    lead.robustness >= 0.7
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : lead.robustness >= 0.4
        ? 'border-yellow-200 bg-yellow-50 text-yellow-800'
        : 'border-orange-200 bg-orange-50 text-orange-800';

  const fragileBit =
    flips > 0 && fragile.length > 0
      ? ` ${flips} ${plural(flips, 'flip', 'flips')} on ${humaniseFragile(fragile)
          .slice(0, 2)
          .join(', ')}.`
      : flips > 0
        ? ` ${flips} of ${total} ${plural(flips, 'framing flips', 'framings flip')}.`
        : weaker > 0
          ? ` ${weaker} of ${total} weaken on tighter cohort or window cuts.`
          : '';

  const main =
    total === 0
      ? 'Confidence not yet computed — scenarios are still running.'
      : total === 1
        ? holds >= 1
          ? 'Holds in 1 of 1 scenario framing tried so far.'
          : 'Does not hold in the single framing tried so far.'
        : `Holds in ${holds} of ${total} framings.`;

  const triggered = curve.falsifier_status === 'fully_triggered';
  const partial = curve.falsifier_status === 'partially_triggered';
  const falsifierBit = triggered
    ? ' A condition that would prove us wrong has triggered.'
    : partial
      ? ' Some conditions that would prove us wrong are borderline.'
      : '';

  return (
    <p
      className={cn(
        'inline-flex w-fit max-w-full items-start rounded-2xl border px-3 py-2 text-[13px] font-medium leading-snug',
        tone,
      )}
    >
      {main}
      {fragileBit}
      {falsifierBit}
    </p>
  );
}

function ActionRail({
  studyId,
  curve,
}: {
  studyId: string | null;
  curve: SpecCurve;
}) {
  const lead = curve.rows[0];
  const fragile =
    lead != null &&
    (lead.n_flips > 0 ||
      curve.falsifier_status === 'fully_triggered' ||
      curve.falsifier_status === 'partially_triggered');
  const primaryIsMBP = !fragile && GROWTH_DRIVER_AVAILABLE;

  return (
    <FocusCard>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        What&apos;s next
      </h3>
      <div className="mt-3 grid gap-2">
        {primaryIsMBP ? (
          <PrimaryAction
            href={withStudy('/growth-driver', studyId)}
            icon={<TrendingUp className="h-3.5 w-3.5" />}
            label="Take to MBP"
            detail="Carry the lead recommendation into the growth-driver planner."
            tooltip={
              <Tooltip
                title="What this is and isn't"
                body="Is: the single recommendation we'd put in the briefing, with the framings that back it. Isn't: a forecast or a green light for budget — stress-test for the framings that flip."
              />
            }
          />
        ) : (
          <PrimaryAction
            href={withStudy('/robustness', studyId)}
            icon={<Compass className="h-3.5 w-3.5" />}
            label="Stress-test the answer"
            detail="Some framings flip or weaken — see which before acting."
            tooltip={
              <Tooltip
                title="What this is and isn't"
                body="Is: a sensitivity check across every defensible framing of the question. Isn't: a forecast — read which framings flip to judge fragility."
              />
            }
          />
        )}
        {primaryIsMBP ? (
          <SecondaryAction
            href={withStudy('/robustness', studyId)}
            icon={<Compass className="h-3.5 w-3.5" />}
            label="Stress-test"
            detail="See holds, weakens, and flips across framings."
          />
        ) : null}
        <SecondaryAction
          href={withStudy('/ask', studyId)}
          icon={<MessageCircle className="h-3.5 w-3.5" />}
          label="Ask a follow-up"
          detail="Scoped to this study's brief and evidence."
        />
        <SecondaryAction
          href={withStudy('/evidence', studyId)}
          icon={<HelpCircle className="h-3.5 w-3.5" />}
          label="See evidence"
          detail="The grounded claims behind the recommendation."
        />
      </div>
    </FocusCard>
  );
}

function PrimaryAction({
  href,
  icon,
  label,
  detail,
  tooltip,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  detail: string;
  tooltip?: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 rounded-2xl border border-slate-900 bg-slate-950 p-3 text-white shadow-sm">
      <div className="flex items-center gap-1.5">
        <Link
          href={href}
          className="group inline-flex flex-1 items-center gap-1.5 text-[13px] font-semibold transition-colors hover:text-slate-100"
        >
          {icon}
          {label}
          <ArrowRight className="ml-auto h-3.5 w-3.5 text-slate-300 transition-transform group-hover:translate-x-0.5" />
        </Link>
        {tooltip ?? null}
      </div>
      <span className="text-[11px] leading-snug text-slate-300">{detail}</span>
    </div>
  );
}

function SecondaryAction({
  href,
  icon,
  label,
  detail,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  detail: string;
}) {
  return (
    <Link
      href={href}
      className="group grid gap-1 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
    >
      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-slate-900">
        {icon}
        {label}
        <ArrowRight className="ml-auto h-3 w-3 text-slate-400 transition-transform group-hover:translate-x-0.5" />
      </span>
      <span className="text-[11px] leading-snug text-slate-600">{detail}</span>
    </Link>
  );
}

function Tooltip({ title, body }: { title: string; body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={title}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/20 bg-white/10 text-slate-200 transition-colors hover:bg-white/20"
      >
        <HelpCircle className="h-3 w-3" />
      </button>
      {open ? (
        <div
          role="tooltip"
          className="absolute right-0 top-full z-10 mt-1.5 w-64 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] leading-snug text-slate-700 shadow-lg"
        >
          <p className="font-semibold text-slate-900">{title}</p>
          <p className="mt-1">{body}</p>
        </div>
      ) : null}
    </div>
  );
}

function plural(n: number, singular: string, multiple: string): string {
  return n === 1 ? singular : multiple;
}

function humaniseFragile(specs: string[]): string[] {
  return specs.slice(0, 4).map((s) => s.replace(/__/g, ' / ').replace(/_/g, ' '));
}

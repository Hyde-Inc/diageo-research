'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, Play, Sparkles } from 'lucide-react';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData } from '@/components/study/use-study';
import { wb, type PlanReviseResponse } from '@/components/workbench/types';
import { cn } from '@/lib/utils';

const EXAMPLE_INSTRUCTIONS = [
  'Focus on the Casual Unwind occasion and drop the collaboration taxonomy.',
  'Drop the collaboration framing and weight the post-inflation window only.',
  'Narrow the audience to the sub-$60k household income cohort.',
];

export default function PlanPage() {
  const data = useStudyData();
  const { studyId, detail } = data;
  const searchParams = useSearchParams();
  const prefill = searchParams.get('prefill');
  const [draft, setDraft] = useState('');

  // Seed the textarea once from the ``?prefill=`` query so links from
  // /evidence (and other surfaces) can suggest a revision without
  // overwriting in-progress user input on every render.
  const seededRef = useRef<string | null>(null);
  useEffect(() => {
    if (!prefill || seededRef.current === prefill) return;
    seededRef.current = prefill;
    setDraft(prefill);
  }, [prefill]);
  const [preview, setPreview] = useState<PlanReviseResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<PlanReviseResponse | null>(null);

  const runRevise = useCallback(
    async (apply: boolean, rerun: boolean) => {
      if (!studyId || !draft.trim()) return;
      setPending(true);
      setError(null);
      try {
        const res = await wb.planRevise(studyId, {
          instruction: draft.trim(),
          apply,
          rerun,
        });
        setPreview(res);
        if (apply) setLastApplied(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPending(false);
      }
    },
    [studyId, draft],
  );

  return (
    <StudyShell
      data={data}
      eyebrow="Plan"
      title="Revise the research plan in plain language"
      intro="Describe a change in plain English, preview what it would alter, then apply and re-run one scenario as proof."
    >
      <FocusCard className="p-0 sm:p-0">
        <div className="grid gap-3 p-4 sm:p-5">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Sparkles className="h-4 w-4 text-blue-600" />
            {detail?.question ?? 'Pick a study to edit its plan.'}
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder='Describe the change in plain English — e.g. "focus on Casual Unwind and drop the collaboration framing".'
            disabled={!studyId || pending}
            className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-inner outline-none focus-visible:ring-2 focus-visible:ring-slate-200"
          />
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_INSTRUCTIONS.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setDraft(ex)}
                className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600 hover:bg-white"
              >
                {ex}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!studyId || pending || !draft.trim()}
              onClick={() => void runRevise(false, false)}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-800 shadow-sm',
                'hover:bg-slate-50 disabled:opacity-50',
              )}
            >
              Preview what would change
            </button>
            <button
              type="button"
              disabled={!studyId || pending || !draft.trim()}
              onClick={() => void runRevise(true, true)}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-full bg-slate-950 px-4 text-xs font-semibold text-white shadow-sm',
                'hover:bg-slate-800 disabled:opacity-50',
              )}
              title="Applies the plan change and re-runs one scenario as proof. Other scenarios stay queued for a full re-run."
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Apply and re-run one scenario
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            “Apply and re-run one scenario” will write the change to the
            plan and start one fresh scenario as proof. The remaining
            scenarios stay queued and you can re-run all of them later.
          </p>
          {error ? (
            <p className="text-sm text-orange-700">{error}</p>
          ) : null}
        </div>
      </FocusCard>

      {preview ? (
        <FocusCard>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            What this change would do
          </h3>
          <ul className="mt-2 grid gap-1 text-sm text-slate-700">
            {preview.diff_lines.map((line, i) => (
              <li key={i} className="leading-snug">
                — {humaniseDiffLine(line)}
              </li>
            ))}
          </ul>
          {preview.applied && preview.queued_cell_id ? (
            <div className="mt-3 grid gap-1 rounded-xl border border-emerald-200 bg-emerald-50/80 px-3 py-2 text-[12px] text-emerald-900">
              <span className="font-semibold">Now running:</span>
              <span>
                One scenario re-running for proof —{' '}
                <span className="font-medium">{preview.queued_cell_id}</span>.
                Other scenarios stay queued for a full re-run.
              </span>
            </div>
          ) : null}
        </FocusCard>
      ) : null}

      {lastApplied ? (
        <p className="text-[11px] text-slate-500">
          Last applied change: {lastApplied.diff_lines.map(humaniseDiffLine).join(' · ')}
        </p>
      ) : null}
    </StudyShell>
  );
}

function humaniseDiffLine(line: string): string {
  return line
    .replace(/^\s*[-+]\s*/, '')
    .replace(/\baxes\b/gi, 'dimensions')
    .replace(/\bcells?\b/gi, (m) => (m === 'cell' ? 'scenario' : 'scenarios'))
    .replace(/\bprereg\b/gi, 'pre-registered plan')
    .replace(/\bfalsifier(s)?\b/gi, (_match, plural) =>
      plural ? 'wrong-way conditions' : 'wrong-way condition',
    )
    .replace(/\bspec curve\b/gi, 'robustness grid')
    .trim();
}

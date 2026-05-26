'use client';

import { useCallback, useState } from 'react';
import { Loader2, Play, Sparkles } from 'lucide-react';
import { FocusCard, StudyShell } from '@/components/study/study-shell';
import { useStudyData } from '@/components/study/use-study';
import { wb, type PlanReviseResponse } from '@/components/workbench/types';
import { cn } from '@/lib/utils';

const EXAMPLE_INSTRUCTIONS = [
  'focus on tequila + Casual Unwind, drop the colab taxonomy',
  'drop colab and weight post-inflation window only',
  'narrow to sub-$60k cohort',
];

export default function PlanPage() {
  const data = useStudyData();
  const { studyId, detail } = data;
  const [draft, setDraft] = useState('');
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
      title="Revise the research plan"
      intro="Describe how to change the study in plain language, preview the spec diff, then apply and re-run one scenario as proof."
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
            placeholder='e.g. "focus on tequila + Casual Unwind, drop the colab taxonomy"'
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
              Preview diff
            </button>
            <button
              type="button"
              disabled={!studyId || pending || !draft.trim()}
              onClick={() => void runRevise(true, true)}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-full bg-slate-950 px-4 text-xs font-semibold text-white shadow-sm',
                'hover:bg-slate-800 disabled:opacity-50',
              )}
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Apply &amp; re-run one scenario
            </button>
          </div>
          {error ? (
            <p className="text-sm text-orange-700">{error}</p>
          ) : null}
        </div>
      </FocusCard>

      {preview ? (
        <FocusCard>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Spec diff preview
          </h3>
          <ul className="mt-2 grid gap-1 text-sm text-slate-700">
            {preview.diff_lines.map((line, i) => (
              <li key={i} className="leading-snug">
                — {line}
              </li>
            ))}
          </ul>
          {preview.applied && preview.queued_cell_id ? (
            <p className="mt-3 text-[12px] text-slate-600">
              Queued re-materialization for scenario{' '}
              <span className="font-mono">{preview.queued_cell_id}</span>
              {preview.queued_run_id ? (
                <>
                  {' '}
                  (<span className="font-mono">{preview.queued_run_id}</span>)
                </>
              ) : null}
              . Remaining scenarios stay queued for a full re-run.
            </p>
          ) : null}
        </FocusCard>
      ) : null}

      {lastApplied ? (
        <p className="text-[11px] text-slate-500">
          Last apply: {lastApplied.diff_lines.join(' · ')}
        </p>
      ) : null}
    </StudyShell>
  );
}

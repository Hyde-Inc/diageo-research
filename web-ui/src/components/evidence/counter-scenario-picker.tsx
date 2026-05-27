'use client';

import { ArrowRight, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { wb } from '@/components/workbench/types';
import type {
  BrainstormCounterScenariosResponse,
  CounterScenarioCandidate,
} from '@/components/workbench/types';

const SUPPORTED_PROMPTS = new Set([
  'flip-fragile-assumption',
  'cut-ap-30',
  'add-competitor-response',
  'alternative-driver',
  'discount-vs-bundle',
  'inverse-causal',
  'flip-audience-cut',
  'flip-time-window',
  'flip-taxonomy',
]);
const FALLBACK_PROMPT = 'discount-vs-bundle';

type Props = {
  studyId: string | null;
  clusterId: number | null;
  findingIndex: number | null;
};

/** Disclosure-style picker that brainstorms 3–5 LLM-generated
 *  counter-scenarios for the current cluster. Each card links into
 *  /simulation pre-filled with the suggested typed prompt + params. */
export function CounterScenarioPicker({
  studyId,
  clusterId,
  findingIndex,
}: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BrainstormCounterScenariosResponse | null>(
    null,
  );

  const canFetch = studyId != null && clusterId != null;

  const fetchCandidates = useCallback(
    async (refresh: boolean) => {
      if (!canFetch || studyId == null || clusterId == null) return;
      setLoading(true);
      setError(null);
      try {
        const res = await wb.brainstormCounterScenarios(studyId, clusterId, {
          refresh,
        });
        setData(res);
      } catch (e) {
        setData(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [canFetch, studyId, clusterId],
  );

  function handleToggle() {
    setOpen((prev) => {
      const next = !prev;
      if (next && data == null && !loading && canFetch) {
        void fetchCandidates(false);
      }
      return next;
    });
  }

  function buildSimulationHref(c: CounterScenarioCandidate): string {
    const params = new URLSearchParams();
    if (studyId) params.set('study', studyId);
    const prompt = SUPPORTED_PROMPTS.has(c.suggested_prompt)
      ? c.suggested_prompt
      : FALLBACK_PROMPT;
    params.set('prompt', prompt);
    if (findingIndex != null) params.set('finding', String(findingIndex));
    if (c.suggested_prompt !== prompt || c.swap) {
      params.set('note', c.swap);
    }
    for (const [k, v] of Object.entries(c.suggested_simulation_params ?? {})) {
      if (!params.has(k) && v) params.set(k, v);
    }
    return `/simulation?${params.toString()}`;
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white">
      <button
        type="button"
        onClick={handleToggle}
        disabled={!canFetch}
        className={cn(
          'flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left',
          'transition-colors hover:bg-slate-50',
          !canFetch && 'cursor-not-allowed opacity-60',
        )}
      >
        <span className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" aria-hidden />
          <span className="text-[13px] font-semibold text-slate-900">
            {open ? 'Hide counter-scenarios' : 'Brainstorm counter-scenarios'}
          </span>
        </span>
        <Badge variant="outline" className="text-[10px] font-medium">
          {open ? 'Showing' : 'LLM-generated'}
        </Badge>
      </button>
      {open ? (
        <div className="border-t border-slate-200 px-4 py-3">
          {loading ? (
            <p className="text-[12px] text-slate-500">
              Brainstorming 3–5 counter-scenarios from the agreeing
              briefs…
            </p>
          ) : error ? (
            <div className="grid gap-2 text-[12px] text-orange-700">
              <p>
                Couldn&apos;t reach the brainstorm service. You can
                still run a typed counter-scenario from{' '}
                <Link
                  href="/simulation"
                  className="font-medium text-orange-800 underline-offset-2 hover:underline"
                >
                  /simulation
                </Link>
                .
              </p>
              <p className="font-mono text-[11px] text-orange-600">
                {error}
              </p>
              <button
                type="button"
                onClick={() => fetchCandidates(false)}
                className="w-fit rounded-full border border-orange-300 bg-orange-50 px-3 py-1 text-[11px] font-medium text-orange-800 hover:bg-orange-100"
              >
                Try again
              </button>
            </div>
          ) : data == null || data.candidates.length === 0 ? (
            <p className="text-[12px] text-slate-500">
              No candidates returned.{' '}
              <button
                type="button"
                onClick={() => fetchCandidates(true)}
                className="font-medium text-slate-700 underline-offset-2 hover:underline"
              >
                Re-brainstorm
              </button>
            </p>
          ) : (
            <div className="grid gap-2">
              {data.candidates.map((c) => (
                <article
                  key={c.id}
                  className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="grid gap-0.5">
                      <h4 className="text-[13px] font-semibold leading-tight text-slate-900">
                        {c.title}
                      </h4>
                      <p className="text-[11px] font-medium text-slate-600">
                        {c.swap}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className="shrink-0 text-[10px] font-medium"
                      title={c.suggested_prompt}
                    >
                      {prettifyPromptKey(c.suggested_prompt)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-slate-700">
                    {c.expected_effect}
                  </p>
                  <div className="mt-2 flex items-center justify-end">
                    <Link
                      href={buildSimulationHref(c)}
                      className="inline-flex items-center gap-1 rounded-full bg-slate-900 px-3 py-1 text-[11px] font-medium text-white hover:bg-slate-700"
                    >
                      Run this counter-scenario
                      <ArrowRight className="h-3 w-3" aria-hidden />
                    </Link>
                  </div>
                </article>
              ))}
              <div className="flex items-center justify-between pt-1">
                <p className="text-[10px] text-slate-500">
                  {data.cached
                    ? 'Loaded from cache (≤ 7 days). '
                    : 'Fresh from the brainstorm model. '}
                </p>
                <button
                  type="button"
                  onClick={() => fetchCandidates(true)}
                  className="text-[11px] font-medium text-slate-700 underline-offset-2 hover:underline"
                >
                  Re-brainstorm
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function prettifyPromptKey(key: string): string {
  return key
    .replace(/[-_]/g, ' ')
    .replace(/\bap\b/gi, 'A&P')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

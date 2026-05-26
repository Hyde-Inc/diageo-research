'use client';

/**
 * Workbench Ask pane.
 *
 * Plain-language Q&A over the active study. Posts to
 * `POST /studies/{id}/ask` (proxied via `/api/workbench/...`) and
 * renders the structured `{ answer, citations, unknowns }` payload.
 *
 * Surface contract:
 *   - Seeded example prompts as chips (clicking prefills the input).
 *   - Single-line input with shift-to-multiline textarea behaviour.
 *   - When a scenario is active in workbench state (`activeCellId`),
 *     the request scopes the answer to that scenario and the UI
 *     surfaces a small "scoped to ..." badge.
 *   - Errors surface inline; no silent stubs.
 *   - Sources are collapsed under a disclosure so the answer reads first.
 *
 * Refactored into two parts so the same conversation surface can host
 * the /ask focused page without duplicating logic:
 *   - `AskConversation` is the conversation card alone (input, turns,
 *     citations, unknowns). Used by /ask/page.tsx via StudyShell.
 *   - `PaneAsk` wraps `AskConversation` with the workbench's pane-style
 *     gradient header so it reads as one of the tabs.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  Focus,
  Info,
  Loader2,
  MessageSquare,
  Send,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  wb,
  type AskCitation,
  type AskResponse,
  type SpecCurve,
  type StudyDetail,
} from './types';

const EXAMPLE_PROMPTS = [
  'What is the lead recommendation and how confident should I be?',
  'Which scenarios disagree most, and what does the disagreement tell us?',
  'What would prove this study wrong?',
];

type Turn =
  | {
      id: number;
      role: 'user';
      content: string;
      scenarioId: string | null;
    }
  | {
      id: number;
      role: 'assistant';
      response: AskResponse;
      scenarioId: string | null;
    }
  | {
      id: number;
      role: 'error';
      message: string;
      scenarioId: string | null;
    };

export type AskConversationProps = {
  studyId: string | null;
  detail: StudyDetail | null;
  curve: SpecCurve | null;
  activeCellId: string | null;
  /** When true, the conversation panel adapts to a wider, page-style
   * frame instead of the workbench's compact pane chrome. */
  layout?: 'page' | 'pane';
};

export function AskConversation({
  studyId,
  detail,
  activeCellId,
  layout = 'pane',
}: AskConversationProps) {
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);

  const ready = Boolean(studyId && detail);

  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !studyId || pending) return;
      const scenarioId = activeCellId;
      const userTurn: Turn = {
        id: Date.now(),
        role: 'user',
        content: trimmed,
        scenarioId,
      };
      setTurns((prev) => [...prev, userTurn]);
      setDraft('');
      setPending(true);
      try {
        const response = await wb.ask(studyId, {
          question: trimmed,
          scenario_id: scenarioId ?? undefined,
        });
        setTurns((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            role: 'assistant',
            response,
            scenarioId,
          },
        ]);
      } catch (err) {
        setTurns((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            role: 'error',
            message:
              err instanceof Error
                ? err.message
                : 'The answerer did not respond. Try again or check the API.',
            scenarioId,
          },
        ]);
      } finally {
        setPending(false);
      }
    },
    [studyId, activeCellId, pending],
  );

  const isPage = layout === 'page';
  return (
    <div
      className={cn(
        'grid gap-3 rounded-2xl border bg-white shadow-sm shadow-slate-950/[0.04]',
        isPage ? 'border-slate-200/80' : 'border-slate-200',
      )}
    >
      <div
        className={cn(
          'grid gap-3 overflow-y-auto p-4',
          isPage ? 'max-h-[60vh] sm:p-5' : 'max-h-[480px]',
        )}
        aria-live="polite"
      >
        {turns.length === 0 ? (
          <EmptyConversation ready={ready} />
        ) : (
          turns.map((turn) => <TurnRow key={turn.id} turn={turn} />)
        )}
        {pending ? <PendingRow /> : null}
      </div>
      <div className="border-t border-slate-100 bg-slate-50/70 p-3 sm:p-4">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSend(draft);
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              detail
                ? `Ask about "${truncate(detail.question, 70)}"…`
                : 'Pick a study, then ask a question…'
            }
            rows={1}
            disabled={!ready || pending}
            className={cn(
              'flex-1 resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner outline-none',
              'placeholder:text-slate-400 focus-visible:border-slate-400 focus-visible:ring-2 focus-visible:ring-slate-200',
              'disabled:cursor-not-allowed disabled:bg-slate-50',
            )}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend(draft);
              }
            }}
          />
          <button
            type="submit"
            disabled={!ready || pending || draft.trim().length === 0}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-full bg-slate-950 px-3 text-xs font-semibold text-white shadow-sm transition-colors',
              'hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300',
            )}
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            {pending ? 'Thinking' : 'Ask'}
          </button>
        </form>
        <div
          className={cn(
            'mt-2 grid gap-1.5',
            isPage ? 'sm:grid-cols-3' : 'sm:grid-cols-3',
          )}
        >
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => setDraft(prompt)}
              disabled={!ready || pending}
              className={cn(
                'group inline-flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-[11px] text-slate-700 shadow-sm transition-colors',
                'hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60',
              )}
            >
              <span className="line-clamp-2">{prompt}</span>
              <ArrowUpRight className="h-3 w-3 shrink-0 text-slate-400 group-hover:text-slate-600" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PaneAsk(props: AskConversationProps) {
  const { detail, curve, activeCellId } = props;
  const scenarioLabel = useMemo(() => {
    if (!activeCellId) return null;
    return activeCellId.replace(/__/g, ' / ');
  }, [activeCellId]);
  const completedCount = useMemo(
    () => curve?.cells?.filter((c) => c.status === 'complete').length ?? 0,
    [curve],
  );
  return (
    <section
      className="grid gap-4"
      data-testid="pane-ask"
      aria-label="Ask over this study"
    >
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-blue-50/80 via-white to-white p-4 shadow-sm shadow-slate-950/[0.04]">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-blue-600/10 text-blue-700">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <h3 className="text-sm font-semibold tracking-tight text-slate-900">
            Ask over this study
          </h3>
          {scenarioLabel ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">
              <Focus className="h-3 w-3" />
              Scoped to {scenarioLabel}
            </span>
          ) : null}
        </div>
        <p className="mt-1 max-w-3xl text-sm leading-snug text-slate-600">
          Answers come from this study&rsquo;s own brief, cross-scenario
          summary, and the conditions that would prove it wrong&mdash;
          paraphrased, not parroted.{' '}
          {completedCount > 0 ? (
            <>
              {completedCount} of {curve?.n_cells ?? '—'} scenarios complete.
            </>
          ) : detail ? (
            <>No scenarios are complete yet — answers will be light.</>
          ) : null}
        </p>
      </div>
      <AskConversation {...props} />
    </section>
  );
}

function EmptyConversation({ ready }: { ready: boolean }) {
  return (
    <div className="grid place-items-center gap-1.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 px-4 py-8 text-center text-sm text-slate-500">
      <MessageSquare className="h-4 w-4 text-slate-400" />
      <p>
        {ready
          ? 'Type a question or click a prompt below to start.'
          : 'Pick a study from the top right to start a thread.'}
      </p>
      <p className="text-[11px] text-slate-400">
        Answers ground in this study&rsquo;s own brief and cross-scenario
        summary.
      </p>
    </div>
  );
}

function PendingRow() {
  return (
    <div className="mr-auto inline-flex max-w-[85%] items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 shadow-sm">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
      Drafting a plain-language answer&hellip;
    </div>
  );
}

function TurnRow({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <div className="ml-auto grid max-w-[85%] gap-1 rounded-2xl bg-slate-950 px-3 py-2 text-sm text-slate-50 shadow-sm">
        <span className="font-mono text-[9px] uppercase tracking-wider text-slate-300">
          You
          {turn.scenarioId ? (
            <span className="ml-2 normal-case tracking-normal text-blue-200">
              · scoped to {turn.scenarioId.replace(/__/g, ' / ')}
            </span>
          ) : null}
        </span>
        <p className="whitespace-pre-wrap leading-snug">{turn.content}</p>
      </div>
    );
  }
  if (turn.role === 'error') {
    return (
      <div className="mr-auto grid max-w-[85%] gap-1.5 rounded-2xl border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-800 shadow-sm">
        <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-orange-700">
          <AlertTriangle className="h-3 w-3" />
          Answerer error
        </span>
        <p className="whitespace-pre-wrap leading-snug">{turn.message}</p>
        <p className="text-[11px] text-orange-700/80">
          The request failed. Confirm the API is running and try again.
        </p>
      </div>
    );
  }
  const { response } = turn;
  return (
    <div className="mr-auto grid max-w-[88%] gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 shadow-sm">
      <span className="font-mono text-[9px] uppercase tracking-wider text-slate-500">
        Answer
      </span>
      <AnswerBody answer={response.answer} />
      {response.unknowns.length > 0 ? (
        <UnknownsBlock unknowns={response.unknowns} />
      ) : null}
      {response.citations.length > 0 ? (
        <SourcesDisclosure citations={response.citations} />
      ) : null}
    </div>
  );
}

function AnswerBody({ answer }: { answer: string }) {
  // The model emits citation markers like [B1] / [C1] / [R] / [F1].
  // They live in the prose for traceability; render them as small,
  // muted chips so the prose still reads first.
  const parts = useMemo(() => splitWithMarkers(answer), [answer]);
  return (
    <p className="whitespace-pre-wrap leading-relaxed">
      {parts.map((part, idx) =>
        part.type === 'marker' ? (
          <span
            key={idx}
            className="mx-0.5 inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-1 py-0 font-mono text-[10px] uppercase tracking-wider text-slate-500"
          >
            {part.text}
          </span>
        ) : (
          <span key={idx}>{part.text}</span>
        ),
      )}
    </p>
  );
}

function UnknownsBlock({ unknowns }: { unknowns: string[] }) {
  return (
    <div className="grid gap-1 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-[12px] text-amber-800">
      <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-amber-700">
        <Info className="h-3 w-3" />
        Caveats from the study
      </span>
      <ul className="grid gap-0.5">
        {unknowns.map((u, idx) => (
          <li key={idx} className="leading-snug">
            &ndash; {u}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourcesDisclosure({ citations }: { citations: AskCitation[] }) {
  return (
    <details className="group rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 text-[12px] text-slate-700">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
        <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
        Sources &middot; {citations.length}
      </summary>
      <ul className="mt-1.5 grid gap-1.5">
        {citations.map((c, idx) => (
          <li
            key={idx}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 leading-snug shadow-sm"
          >
            <div className="font-semibold text-slate-700">{c.source}</div>
            <div className="text-slate-600">{c.snippet}</div>
            {c.link ? (
              <a
                href={c.link}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 hover:underline"
              >
                Open
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function splitWithMarkers(
  text: string,
): Array<{ type: 'text' | 'marker'; text: string }> {
  const re = /\[([A-Z]\d*)\]/g;
  const out: Array<{ type: 'text' | 'marker'; text: string }> = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      out.push({ type: 'text', text: text.slice(last, match.index) });
    }
    out.push({ type: 'marker', text: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    out.push({ type: 'text', text: text.slice(last) });
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

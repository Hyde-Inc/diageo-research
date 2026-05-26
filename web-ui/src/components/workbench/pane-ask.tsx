'use client';

/**
 * Workbench Ask pane.
 *
 * Conversational entry over the active study. The backend does not yet
 * expose an /ask endpoint, so this pane is intentionally a placeholder
 * that reads as part of the product rather than a broken stub:
 *
 *   - Visible "coming next" tag (no false expectations).
 *   - Live local echo response that names the study + tip-of-the-iceberg
 *     stats so the audience can feel the affordance work end-to-end.
 *   - Three example prompts wired to the input so the demo flow is one
 *     click long.
 *
 * When the backend `POST /studies/{id}/ask` lands, swap the local echo
 * for a fetch — the rest of the surface area is shaped for it.
 */

import { useCallback, useMemo, useState } from 'react';
import { ArrowUpRight, MessageSquare, Send, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SpecCurve, StudyDetail } from './types';

type Turn = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
};

const EXAMPLE_PROMPTS = [
  'What is the lead recommendation and how robust is it?',
  'Which cells disagree most and why?',
  'Did any falsifier condition trigger?',
];

export function PaneAsk({
  detail,
  curve,
}: {
  detail: StudyDetail | null;
  curve: SpecCurve | null;
}) {
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);

  const stub = useMemo(() => buildStub(detail, curve), [detail, curve]);

  const handleSend = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setTurns((prev) => [
        ...prev,
        { id: prev.length, role: 'user', content: trimmed },
        {
          id: prev.length + 1,
          role: 'assistant',
          content: stub,
        },
      ]);
      setDraft('');
    },
    [stub],
  );

  return (
    <section
      className="grid gap-4"
      data-testid="pane-ask"
      aria-label="Ask over this study"
    >
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-blue-50/80 via-white to-white p-4 shadow-sm shadow-slate-950/[0.04]">
        <div className="flex items-baseline gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-blue-600/10 text-blue-700">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <h3 className="text-sm font-semibold tracking-tight text-slate-900">
            Ask over this study
          </h3>
          <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">
            preview
          </span>
        </div>
        <p className="mt-1 max-w-3xl text-sm leading-snug text-slate-600">
          A natural-language thread over the recipe, the universe of cells,
          and the spec curve. Today this echoes a stub answer from what
          we already know about the study — wiring to a live answerer
          lands in the next iteration.
        </p>
      </div>

      <div className="grid gap-3 rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-950/[0.04]">
        <div className="grid max-h-[360px] gap-2 overflow-y-auto p-4">
          {turns.length === 0 ? (
            <EmptyConversation />
          ) : (
            turns.map((turn) => <TurnRow key={turn.id} turn={turn} />)
          )}
        </div>
        <div className="border-t border-slate-100 bg-slate-50/70 p-3">
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              handleSend(draft);
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                detail
                  ? `Ask about “${truncate(detail.question, 70)}”…`
                  : 'Pick a study, then ask a question…'
              }
              rows={1}
              disabled={!detail}
              className={cn(
                'flex-1 resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner outline-none',
                'placeholder:text-slate-400 focus-visible:border-slate-400 focus-visible:ring-2 focus-visible:ring-slate-200',
                'disabled:cursor-not-allowed disabled:bg-slate-50',
              )}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend(draft);
                }
              }}
            />
            <button
              type="submit"
              disabled={!detail || draft.trim().length === 0}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-full bg-slate-950 px-3 text-xs font-semibold text-white shadow-sm transition-colors',
                'hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300',
              )}
            >
              <Send className="h-3.5 w-3.5" />
              Ask
            </button>
          </form>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
            {EXAMPLE_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => handleSend(prompt)}
                disabled={!detail}
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
    </section>
  );
}

function EmptyConversation() {
  return (
    <div className="grid place-items-center gap-1.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 px-4 py-8 text-center text-sm text-slate-500">
      <MessageSquare className="h-4 w-4 text-slate-400" />
      <p>Type a question, or pick one of the prompts below.</p>
      <p className="text-[11px] text-slate-400">
        Live answers will arrive when the /ask endpoint ships.
      </p>
    </div>
  );
}

function TurnRow({ turn }: { turn: Turn }) {
  const isUser = turn.role === 'user';
  return (
    <div
      className={cn(
        'grid max-w-[85%] gap-1 rounded-2xl px-3 py-2 text-sm shadow-sm',
        isUser
          ? 'ml-auto bg-slate-950 text-slate-50'
          : 'mr-auto border border-slate-200 bg-white text-slate-800',
      )}
    >
      <span
        className={cn(
          'font-mono text-[9px] uppercase tracking-wider',
          isUser ? 'text-slate-300' : 'text-slate-500',
        )}
      >
        {isUser ? 'you' : 'assistant · stub'}
      </span>
      <p className="whitespace-pre-wrap leading-snug">{turn.content}</p>
    </div>
  );
}

function buildStub(detail: StudyDetail | null, curve: SpecCurve | null): string {
  if (!detail) {
    return 'Pick a study to start a thread.';
  }
  const lead = curve?.rows[0];
  const robust = lead ? `${Math.round(lead.robustness * 100)}%` : '—';
  const lines: string[] = [];
  lines.push(`Study “${detail.name}” — ${detail.cells.length} cells.`);
  if (lead) {
    lines.push(
      `Lead recommendation (${robust} robust): ${truncate(lead.representative, 220)}`,
    );
  }
  if (curve) {
    lines.push(
      `Falsifier status: ${curve.falsifier_status.replace(/_/g, ' ')}.`,
    );
  }
  lines.push(
    'This is a stub. Live answers will quote evidence from the cells, brief, and spec curve directly.',
  );
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

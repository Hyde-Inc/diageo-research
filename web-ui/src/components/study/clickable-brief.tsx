'use client';

import { useMemo, useState } from 'react';
import { EvidenceTraceSheet } from '@/components/study/evidence-trace-sheet';
import { cn } from '@/lib/utils';

const NUM_RE = /(\d+(?:\.\d+)?%?)/g;

export function ClickableBrief({
  markdown,
  studyId,
  leadClusterId,
}: {
  markdown: string;
  studyId: string | null;
  leadClusterId?: number | null;
}) {
  const [traceOpen, setTraceOpen] = useState(false);
  const [activeTrace, setActiveTrace] = useState<{
    id: string;
    metric?: string;
    label: string;
  } | null>(null);

  const blocks = useMemo(() => splitMarkdownBlocks(markdown), [markdown]);

  return (
    <>
      <article className="prose prose-slate max-w-none prose-p:text-sm prose-p:leading-relaxed prose-headings:text-slate-900">
        {blocks.map((block, bi) =>
          block.type === 'heading' ? (
            <h3 key={bi} className="mt-4 text-sm font-semibold first:mt-0">
              {block.text}
            </h3>
          ) : (
            <p key={bi} className="text-sm leading-relaxed text-slate-700">
              {tokenizeNumbers(block.text).map((part, pi) =>
                part.type === 'num' ? (
                  <button
                    key={pi}
                    type="button"
                    className={cn(
                      'mx-0.5 inline rounded-md border border-blue-200 bg-blue-50 px-1 py-0 font-semibold tabular-nums text-blue-800',
                      'underline-offset-2 hover:bg-blue-100 hover:underline',
                    )}
                    onClick={() => {
                      setActiveTrace({
                        id: part.text,
                        metric: part.text.includes('%')
                          ? 'robustness'
                          : 'count',
                        label: part.text,
                      });
                      setTraceOpen(true);
                    }}
                  >
                    {part.text}
                  </button>
                ) : (
                  <span key={pi}>{part.text}</span>
                ),
              )}
            </p>
          ),
        )}
      </article>
      {studyId && activeTrace ? (
        <EvidenceTraceSheet
          studyId={studyId}
          open={traceOpen}
          onOpenChange={setTraceOpen}
          traceId={activeTrace.id}
          clusterId={leadClusterId ?? undefined}
          metric={activeTrace.metric}
          label={activeTrace.label}
        />
      ) : null}
    </>
  );
}

function splitMarkdownBlocks(
  md: string,
): Array<{ type: 'heading' | 'para'; text: string }> {
  const out: Array<{ type: 'heading' | 'para'; text: string }> = [];
  for (const chunk of md.split(/\n\n+/)) {
    const t = chunk.trim();
    if (!t) continue;
    if (t.startsWith('### ')) {
      out.push({ type: 'heading', text: t.replace(/^###\s+/, '') });
    } else if (t.startsWith('## ')) {
      out.push({ type: 'heading', text: t.replace(/^##\s+/, '') });
    } else {
      out.push({ type: 'para', text: t.replace(/\n/g, ' ') });
    }
  }
  return out;
}

function tokenizeNumbers(
  text: string,
): Array<{ type: 'text' | 'num'; text: string }> {
  const out: Array<{ type: 'text' | 'num'; text: string }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(NUM_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ type: 'text', text: text.slice(last, m.index) });
    }
    out.push({ type: 'num', text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ type: 'text', text: text.slice(last) });
  }
  return out.length ? out : [{ type: 'text', text }];
}

'use client';

/**
 * Surface verifier failures above the Sources step on /evidence/[id].
 *
 * The synthesizer's verifier re-executes SQL citations and re-fetches
 * web docs; rows whose ``verification_note`` looks like
 * "re-exec error", "catalog error", "table … does not exist", or
 * "0 rows but citation cites …" indicate the brief is leaning on a
 * source that no longer survives re-verification — treat them as
 * background context, not load-bearing evidence.
 */

import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { VerifierFlag } from './source-helpers';

export function VerifierFlags({ flags }: { flags: VerifierFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <section className="grid gap-2 rounded-2xl border border-amber-200 bg-amber-50/80 p-3 shadow-sm">
      <header className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" />
        <p className="text-[12px] font-semibold text-amber-900">
          {flags.length} citation{flags.length === 1 ? '' : 's'} failed
          automated verification — treat as background context, not
          load-bearing evidence.
        </p>
      </header>
      <ul className="grid gap-1.5">
        {flags.map((flag) => (
          <li
            key={flag.cite_id}
            className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-2 rounded-xl border border-amber-200/70 bg-white px-2.5 py-1.5 text-[11px] shadow-inner"
          >
            <span className="font-mono text-[10px] font-semibold text-amber-800">
              [{flag.cite_id}]
            </span>
            <Badge
              variant="outline"
              className="border-amber-200 bg-amber-50 text-[9px] uppercase tracking-wider text-amber-700"
            >
              {flag.kind === 'sql' ? 'SQL re-exec' : 'web re-fetch'}
            </Badge>
            <span className="text-slate-700">{flag.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

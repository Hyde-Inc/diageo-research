'use client';

/**
 * Page shell for the focused single-job views.
 *
 * Renders consistent header chrome (study picker + a tiny breadcrumb
 * showing the active study's name + status) above the page body so each
 * focused page can stay narrow and opinionated about its single job.
 *
 * The shell intentionally does NOT replicate the workbench's tab strip
 * — these pages are reachable via the global nav in `app/layout.tsx`
 * and via in-page links between siblings.
 */

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { StudyPicker } from '@/components/workbench/study-picker';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { StudyData } from './use-study';

export function StudyShell({
  data,
  eyebrow,
  title,
  intro,
  back,
  actions,
  contentClassName,
  children,
}: {
  data: StudyData;
  eyebrow?: string;
  title: string;
  intro?: string;
  back?: { href: string; label: string };
  actions?: React.ReactNode;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-svh bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.10),transparent_32rem),linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)] pb-16 font-sans text-slate-950">
      <header className="border-b border-slate-200/80 bg-white/80 px-4 py-3 shadow-sm shadow-slate-950/[0.03] backdrop-blur sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            {back ? (
              <Link
                href={back.href}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 transition-colors hover:text-slate-900"
              >
                <ArrowLeft className="h-3 w-3" />
                {back.label}
              </Link>
            ) : null}
            {eyebrow ? (
              <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                {eyebrow}
              </div>
            ) : null}
            <h1 className="mt-0.5 truncate text-lg font-semibold tracking-tight text-slate-950 sm:text-xl">
              {title}
            </h1>
            {intro ? (
              <p className="mt-0.5 max-w-2xl text-[12px] leading-snug text-slate-500">
                {intro}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StudyPicker
              studies={data.studies}
              studyId={data.studyId}
              onChange={data.setStudyId}
            />
            {actions ?? null}
          </div>
        </div>
      </header>
      <main className="px-4 py-6 sm:px-6">
        <div className={cn('mx-auto grid w-full max-w-3xl gap-4', contentClassName)}>
          {data.studiesError ? (
            <div className="rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-700 shadow-sm">
              Workbench API unreachable · {data.studiesError}
            </div>
          ) : null}
          {!data.studyId && !data.loadingStudies ? (
            <EmptyState>
              No studies on disk yet. Run <code>diageo study</code> to seed
              one, then come back.
            </EmptyState>
          ) : null}
          {children}
        </div>
      </main>
    </div>
  );
}

export function FocusCard({
  children,
  className,
  tone,
}: {
  children: React.ReactNode;
  className?: string;
  tone?: 'default' | 'muted' | 'inverted';
}) {
  return (
    <section
      className={cn(
        'rounded-3xl border p-5 shadow-sm shadow-slate-950/[0.04] sm:p-6',
        tone === 'muted'
          ? 'border-slate-200 bg-slate-50/80'
          : tone === 'inverted'
            ? 'border-slate-900 bg-slate-950 text-slate-50'
            : 'border-slate-200 bg-white/95',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function FocusPlaceholder({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <FocusCard tone="muted" className="border-dashed">
      <div className="flex items-start gap-3">
        <Badge
          variant="outline"
          className="border-slate-300 bg-white text-[10px] font-semibold uppercase tracking-wider text-slate-500"
        >
          coming next
        </Badge>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight text-slate-900">
            {title}
          </h3>
          <p className="mt-1 text-[13px] leading-snug text-slate-600">
            {body}
          </p>
        </div>
      </div>
    </FocusCard>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-dashed border-slate-300 bg-white/80 p-5 text-sm text-slate-500 shadow-sm">
      {children}
    </div>
  );
}

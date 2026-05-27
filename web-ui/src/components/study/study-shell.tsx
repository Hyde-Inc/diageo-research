'use client';

/**
 * Page shell for the focused single-job views.
 *
 * Renders the consistent eyebrow + H1 + (optional) intro and a content
 * area that supports two shapes:
 *
 *   1. Single column (default): pass `children` and the layout matches
 *      the original narrow column — this is what /scenario, /plan,
 *      /ask, etc. still use, and they keep rendering unchanged.
 *
 *   2. Three column: pass any combination of `left`, `main`, and
 *      `right`. /research, /answer, /robustness use this on desktop
 *      (≥1280px). The page collapses to a stacked column on narrow
 *      viewports — the caller can decide what each slot does there by
 *      sizing its own scroll-bounded containers (see /research's
 *      findings rail for an example).
 *
 * The study picker no longer lives in this header — it lives in the
 * global top nav. The shell still owns the page heading and gracefully
 * renders study-error / no-studies states.
 */

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
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
  wrap = true,
  left,
  main,
  right,
  leftLabel,
  rightLabel,
  mainLabel,
  children,
}: {
  data: StudyData;
  eyebrow?: string;
  title: React.ReactNode;
  intro?: string;
  back?: {
    href: string;
    label: string;
    /** When set, the back affordance renders as a button that calls
     * this handler instead of navigating to ``href``. ``href`` is
     * still required so the button can fall back to a deterministic
     * route when there's no history (and so consumers can render a
     * sensible href if they swap the shell out later). */
    onClick?: () => void;
  };
  actions?: React.ReactNode;
  contentClassName?: string;
  /** If false, the header chrome is rendered without the rounded card border. */
  wrap?: boolean;
  /** Three-column slots. Mutually exclusive with `children`. */
  left?: React.ReactNode;
  main?: React.ReactNode;
  right?: React.ReactNode;
  leftLabel?: string;
  mainLabel?: string;
  rightLabel?: string;
  children?: React.ReactNode;
}) {
  const hasSlots = Boolean(left || main || right);
  return (
    <div className="min-h-svh bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.10),transparent_32rem),linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)] pb-16 font-sans text-slate-950">
      <header
        className={cn(
          'border-b border-slate-200/80 px-4 py-4 sm:px-6',
          wrap ? 'bg-white/80 shadow-sm shadow-slate-950/[0.03] backdrop-blur' : '',
        )}
      >
        <div
          className={cn(
            'mx-auto flex w-full flex-wrap items-start gap-3',
            hasSlots ? 'max-w-[1500px]' : 'max-w-3xl',
          )}
        >
          <div className="min-w-0 flex-1">
            {back ? (
              back.onClick ? (
                <button
                  type="button"
                  onClick={back.onClick}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 transition-colors hover:text-slate-900"
                >
                  <ArrowLeft className="h-3 w-3" />
                  {back.label}
                </button>
              ) : (
                <Link
                  href={back.href}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 transition-colors hover:text-slate-900"
                >
                  <ArrowLeft className="h-3 w-3" />
                  {back.label}
                </Link>
              )
            ) : null}
            {eyebrow ? (
              <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                {eyebrow}
              </div>
            ) : null}
            <h1 className="mt-1 text-balance text-xl font-semibold leading-snug tracking-tight text-slate-950 sm:text-2xl">
              {title}
            </h1>
            {intro ? (
              <p className="mt-1 max-w-3xl text-[12px] leading-snug text-slate-500">
                {intro}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          ) : null}
        </div>
      </header>
      <main className="px-4 py-6 sm:px-6">
        <div
          className={cn(
            'mx-auto w-full',
            hasSlots ? 'max-w-[1500px]' : 'max-w-3xl',
            !hasSlots && 'grid gap-4',
            contentClassName,
          )}
        >
          {data.studiesError ? (
            <div className="mb-4 rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-700 shadow-sm">
              Workbench API unreachable · {data.studiesError}
            </div>
          ) : null}
          {!data.studyId && !data.loadingStudies ? (
            <EmptyState>
              No studies on disk yet. Run <code>diageo study</code> to seed
              one, then come back.
            </EmptyState>
          ) : null}
          {hasSlots ? (
            <ThreeColumn
              left={left}
              main={main}
              right={right}
              leftLabel={leftLabel}
              mainLabel={mainLabel}
              rightLabel={rightLabel}
            />
          ) : (
            children
          )}
        </div>
      </main>
    </div>
  );
}

function ThreeColumn({
  left,
  main,
  right,
  leftLabel,
  mainLabel,
  rightLabel,
}: {
  left?: React.ReactNode;
  main?: React.ReactNode;
  right?: React.ReactNode;
  leftLabel?: string;
  mainLabel?: string;
  rightLabel?: string;
}) {
  // Match the column template to the slots actually present so we
  // don't leave a phantom gutter on /answer (main + right only) or any
  // future page that uses left + main only.
  const variant =
    left && right ? 'three' : left ? 'left-main' : right ? 'main-right' : 'main';
  return (
    <div
      className={cn(
        'grid gap-4',
        variant === 'three' &&
          'xl:grid-cols-[minmax(260px,340px)_minmax(0,1fr)_minmax(260px,320px)]',
        variant === 'left-main' &&
          'xl:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]',
        variant === 'main-right' &&
          'xl:grid-cols-[minmax(0,1fr)_minmax(260px,320px)]',
      )}
    >
      {left ? (
        <aside
          aria-label={leftLabel ?? 'Side list'}
          className="xl:sticky xl:top-16 xl:max-h-[calc(100vh-5rem)] xl:overflow-y-auto"
        >
          {left}
        </aside>
      ) : null}
      <section aria-label={mainLabel ?? 'Main content'} className="min-w-0">
        {main}
      </section>
      {right ? (
        <aside
          aria-label={rightLabel ?? 'Action rail'}
          className="xl:sticky xl:top-16 xl:max-h-[calc(100vh-5rem)] xl:overflow-y-auto"
        >
          {right}
        </aside>
      ) : null}
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

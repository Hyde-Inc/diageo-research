'use client';

/**
 * Global header nav.
 *
 * Holds two things:
 *
 *   1. The persistent **study switcher** — a dropdown that controls
 *      the active study for every tab (research, answer, robustness,
 *      evidence, plan, simulation, growth-driver, ask, assets,
 *      scenario, workbench). It polls /studies via the same
 *      `useStudyData` hook the focused pages use, so URL ?study= is
 *      the single source of truth.
 *
 *   2. The nav strip — one link per focused job. The current study is
 *      preserved across links via the `?study=` search param.
 *
 * The strip stays narrow visually so it can share the chrome with the
 * small "ADC Research" brand without dominating it.
 */

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  CheckCircle2,
  Circle,
  Clock,
  Compass,
  DatabaseZap,
  FlaskConical,
  Grid2X2,
  HelpCircle,
  Lightbulb,
  ListChecks,
  MessageCircle,
  PencilLine,
  Settings2,
  ShieldAlert,
  Telescope,
  TrendingUp,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { useStudyData } from '@/components/study/use-study';
import type { StudySummary } from '@/components/workbench/types';
import { cn } from '@/lib/utils';

type NavItem = {
  href: string;
  label: string;
  Icon: LucideIcon;
  /** Activate when the pathname starts with `match` (defaults to href). */
  match?: string;
  tone?: 'primary' | 'secondary';
};

const NAV: NavItem[] = [
  { href: '/research', label: 'Research', Icon: Telescope, tone: 'primary' },
  { href: '/answer', label: 'Answer', Icon: Lightbulb, tone: 'primary' },
  { href: '/robustness', label: 'Robustness', Icon: Compass, tone: 'primary' },
  {
    href: '/why-it-could-be-wrong',
    label: 'Why wrong?',
    Icon: ShieldAlert,
    tone: 'primary',
  },
  {
    href: '/scenario',
    label: 'Scenario',
    Icon: ListChecks,
    match: '/scenario',
    tone: 'primary',
  },
  {
    href: '/growth-driver',
    label: 'Growth Driver',
    Icon: TrendingUp,
    tone: 'primary',
  },
  {
    href: '/evidence',
    label: 'Evidence',
    Icon: HelpCircle,
    match: '/evidence',
    tone: 'primary',
  },
  {
    href: '/assets',
    label: 'Assets',
    Icon: DatabaseZap,
    match: '/assets',
    tone: 'primary',
  },
  { href: '/setup', label: 'Setup', Icon: Settings2, tone: 'primary' },
  { href: '/ask', label: 'Ask', Icon: MessageCircle, tone: 'primary' },
  { href: '/plan', label: 'Plan', Icon: PencilLine, tone: 'primary' },
  {
    href: '/simulation',
    label: 'Simulation',
    Icon: FlaskConical,
    tone: 'primary',
  },
  {
    href: '/workbench',
    label: 'Workbench',
    Icon: Grid2X2,
    tone: 'secondary',
  },
];

export function GlobalNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const study = searchParams.get('study');
  const studyData = useStudyData();

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="hidden lg:flex shrink-0">
        <GlobalStudyPicker data={studyData} />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <ul className="flex min-w-0 items-center gap-1">
          {NAV.map((item) => {
            const match = item.match ?? item.href;
            const active =
              pathname === item.href || pathname.startsWith(`${match}/`);
            const href = study ? `${item.href}?study=${study}` : item.href;
            const isSecondary = item.tone === 'secondary';
            return (
              <li key={item.href} className="shrink-0">
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors',
                    active
                      ? 'border-slate-900 bg-slate-950 text-white shadow-sm'
                      : isSecondary
                        ? 'border-slate-200 bg-slate-50 text-slate-500 hover:border-slate-300 hover:bg-white hover:text-slate-900'
                        : 'border-transparent bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                  )}
                >
                  <item.Icon className="h-3.5 w-3.5" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="lg:hidden shrink-0">
        <GlobalStudyPicker data={studyData} compact />
      </div>
    </div>
  );
}

function GlobalStudyPicker({
  data,
  compact,
}: {
  data: ReturnType<typeof useStudyData>;
  compact?: boolean;
}) {
  const { studies, studyId, studySummary, setStudyId } = data;
  const ordered = [...studies].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );

  if (data.studiesError) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full border border-orange-200 bg-orange-50 px-2.5 py-1 text-[11px] font-medium text-orange-700">
        <XCircle className="h-3 w-3" />
        API offline
      </div>
    );
  }

  if (ordered.length === 0) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 shadow-sm">
        <FlaskConical className="h-3 w-3" />
        No studies yet
      </div>
    );
  }

  return (
    <Select value={studyId ?? undefined} onValueChange={setStudyId}>
      <SelectTrigger
        aria-label="Active study"
        className={cn(
          'h-8 gap-2 rounded-full border-slate-200 bg-white text-sm shadow-sm hover:bg-slate-50',
          compact ? 'min-w-[180px]' : 'min-w-[260px]',
        )}
      >
        <FlaskConical className="h-3.5 w-3.5 text-slate-500" />
        {studySummary ? (
          <PickerSummary summary={studySummary} compact={compact} />
        ) : (
          <span className="truncate text-slate-500">Pick a study</span>
        )}
      </SelectTrigger>
      <SelectContent className="min-w-[320px]">
        {ordered.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
              <StatusGlyph status={s.status} />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {humaniseName(s.name)}
                </div>
                <div className="truncate font-mono text-[10px] text-slate-500">
                  {s.id} · {s.n_complete}/{s.n_cells} scenarios
                </div>
              </div>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PickerSummary({
  summary,
  compact,
}: {
  summary: StudySummary;
  compact?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <StatusDot status={summary.status} />
      <span className="min-w-0 truncate font-medium text-slate-900">
        {humaniseName(summary.name)}
      </span>
      {!compact ? (
        <span className="hidden font-mono text-[10px] text-slate-500 sm:inline">
          {summary.id}
        </span>
      ) : null}
      <span
        className={cn(
          'shrink-0 rounded-full border px-1.5 py-0 text-[10px] font-semibold tabular-nums',
          summary.n_complete === summary.n_cells
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-slate-200 bg-slate-50 text-slate-600',
        )}
      >
        {summary.n_complete}/{summary.n_cells}
      </span>
    </span>
  );
}

function StatusDot({ status }: { status: StudySummary['status'] }) {
  const cls = 'h-2 w-2 rounded-full shrink-0';
  switch (status) {
    case 'complete':
      return <span className={cn(cls, 'bg-emerald-500')} aria-label="complete" />;
    case 'running':
      return (
        <span
          className={cn(cls, 'animate-pulse bg-blue-500')}
          aria-label="running"
        />
      );
    case 'error':
      return <span className={cn(cls, 'bg-orange-500')} aria-label="error" />;
    default:
      return <span className={cn(cls, 'bg-slate-300')} aria-label="pending" />;
  }
}

function StatusGlyph({ status }: { status: StudySummary['status'] }) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  switch (status) {
    case 'complete':
      return <CheckCircle2 className={cn(cls, 'text-emerald-500')} />;
    case 'running':
      return <Clock className={cn(cls, 'animate-pulse text-blue-500')} />;
    case 'error':
      return <XCircle className={cn(cls, 'text-orange-500')} />;
    default:
      return <Circle className={cn(cls, 'text-slate-400')} />;
  }
}

export function humaniseName(value: string): string {
  if (!value) return value;
  return value
    .replace(/_/g, ' ')
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase());
}

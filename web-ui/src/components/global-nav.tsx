'use client';

/**
 * Global left sidebar.
 *
 * Holds:
 *   1. The brand label.
 *   2. A working-context switcher. The label depends on the active
 *      selection — "Crown Royal × NFL MBP" when the active context is
 *      that MBP, otherwise the active study question (truncated). The
 *      dropdown lists all MBPs + all studies; selecting an entry sets
 *      ?study= app-wide via the shared `useStudyData` hook.
 *   3. Primary routes (icon + label) and secondary routes.
 *   4. "Recent decisions" — last five decisions from
 *      GET /assets?kind=decision&limit=5.
 *
 * On narrow viewports (<lg) the sidebar collapses into a top bar with a
 * burger button that opens the same content inside a slide-over Sheet.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  CheckCircle2,
  Circle,
  Clock,
  Compass,
  DatabaseZap,
  FlaskConical,
  Grid2X2,
  HelpCircle,
  Home,
  Lightbulb,
  Menu,
  MessageCircle,
  PencilLine,
  Settings2,
  Telescope,
  TrendingUp,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/ui/select';
import { useStudyData } from '@/components/study/use-study';
import {
  wb,
  type AssetSummary,
  type StudySummary,
} from '@/components/workbench/types';
import { cn } from '@/lib/utils';

type NavItem = { href: string; label: string; Icon: LucideIcon };

const PRIMARY_NAV: NavItem[] = [
  { href: '/', label: 'Home', Icon: Home },
  { href: '/research', label: 'Research', Icon: Telescope },
  { href: '/answer', label: 'Answer', Icon: Lightbulb },
  { href: '/robustness', label: 'Robustness', Icon: Compass },
  { href: '/growth-driver', label: 'Growth driver', Icon: TrendingUp },
  { href: '/simulation', label: 'Simulation', Icon: FlaskConical },
  { href: '/evidence', label: 'Evidence', Icon: HelpCircle },
  { href: '/ask', label: 'Ask', Icon: MessageCircle },
  { href: '/plan', label: 'Plan', Icon: PencilLine },
];

const SECONDARY_NAV: NavItem[] = [
  { href: '/assets', label: 'Assets', Icon: DatabaseZap },
  { href: '/workbench', label: 'Workbench', Icon: Grid2X2 },
  { href: '/setup', label: 'Setup', Icon: Settings2 },
];

// Single seeded MBP for now. Its bound study is study_31c6667a40, so
// the working-context picker treats "Crown Royal × NFL MBP" as a label
// alias for that study id.
const SEEDED_MBP_STUDY = 'study_31c6667a40';
const SEEDED_MBP_LABEL = 'Crown Royal × NFL MBP';

export function GlobalNav() {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <>
      <aside
        aria-label="Primary navigation"
        className="sticky top-0 hidden h-svh w-[220px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-slate-200 bg-white/95 px-3 py-4 backdrop-blur lg:flex"
      >
        <SidebarContents />
      </aside>
      <div className="sticky top-0 z-40 flex h-12 items-center gap-2 border-b border-slate-200 bg-white/95 px-4 backdrop-blur lg:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <button
              type="button"
              aria-label="Open navigation"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white shadow-sm"
            >
              <Menu className="h-4 w-4 text-slate-700" />
            </button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-[260px] max-w-[80vw] overflow-y-auto bg-white p-4"
          >
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarContents onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold tracking-tight text-slate-950"
        >
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-950 text-white shadow-sm">
            <FlaskConical className="h-4 w-4" />
          </span>
          <span className="text-sm">ADC Research</span>
        </Link>
      </div>
    </>
  );
}

function SidebarContents({ onNavigate }: { onNavigate?: () => void }) {
  const data = useStudyData();
  return (
    <>
      <BrandHeader />
      <ContextSwitcher data={data} />
      <NavSection title="Routes">
        <NavList items={PRIMARY_NAV} studyId={data.studyId} onNavigate={onNavigate} />
      </NavSection>
      <NavSection title="Workspaces">
        <NavList items={SECONDARY_NAV} studyId={data.studyId} onNavigate={onNavigate} />
      </NavSection>
      <RecentDecisions studyId={data.studyId} onNavigate={onNavigate} />
    </>
  );
}

function BrandHeader() {
  return (
    <Link
      href="/"
      className="flex items-center gap-2 font-semibold tracking-tight text-slate-950"
    >
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-950 text-white shadow-sm">
        <FlaskConical className="h-4 w-4" />
      </span>
      <span className="text-sm">ADC Research</span>
    </Link>
  );
}

function NavSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-1.5">
      <h2 className="px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

function NavList({
  items,
  studyId,
  onNavigate,
}: {
  items: NavItem[];
  studyId: string | null;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <ul className="grid gap-0.5">
      {items.map((item) => {
        const active =
          item.href === '/'
            ? pathname === '/'
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        const href =
          studyId && item.href !== '/' ? `${item.href}?study=${studyId}` : item.href;
        return (
          <li key={item.href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] font-medium transition-colors',
                active
                  ? 'bg-slate-950 text-white shadow-sm'
                  : 'text-slate-700 hover:bg-slate-100 hover:text-slate-950',
              )}
            >
              <item.Icon className="h-3.5 w-3.5" />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function ContextSwitcher({ data }: { data: ReturnType<typeof useStudyData> }) {
  const { studies, studyId, studySummary, setStudyId } = data;
  const ordered = [...studies].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
  const isMbp = studyId === SEEDED_MBP_STUDY;
  const label = isMbp
    ? SEEDED_MBP_LABEL
    : studySummary
      ? truncate(studySummary.question, 36)
      : ordered.length === 0
        ? 'No studies yet'
        : 'Pick a working context';

  return (
    <section className="grid gap-1">
      <h2 className="px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        Working on
      </h2>
      {data.studiesError ? (
        <div className="inline-flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-2 py-1.5 text-[11px] font-medium text-orange-700">
          <XCircle className="h-3 w-3" />
          API offline
        </div>
      ) : (
        <Select value={studyId ?? undefined} onValueChange={setStudyId}>
          <SelectTrigger
            aria-label="Active working context"
            className="h-9 w-full justify-between rounded-xl border-slate-200 bg-white text-sm shadow-sm hover:bg-slate-50"
          >
            <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-slate-900">
              {label}
            </span>
          </SelectTrigger>
          <SelectContent className="min-w-[280px]">
            <SelectGroup>
              <SelectLabel className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Planning contexts
              </SelectLabel>
              <SelectItem value={SEEDED_MBP_STUDY}>
                <span className="text-sm font-medium">{SEEDED_MBP_LABEL}</span>
              </SelectItem>
            </SelectGroup>
            <SelectGroup>
              <SelectLabel className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Studies
              </SelectLabel>
              {ordered
                .filter((s) => s.id !== SEEDED_MBP_STUDY)
                .map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
                      <StatusGlyph status={s.status} />
                      <span className="min-w-0 truncate text-sm font-medium">
                        {humaniseName(s.name)}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              {ordered.filter((s) => s.id !== SEEDED_MBP_STUDY).length === 0 ? (
                <div className="px-3 py-1.5 text-[11px] text-slate-500">
                  No other studies yet.
                </div>
              ) : null}
            </SelectGroup>
          </SelectContent>
        </Select>
      )}
    </section>
  );
}

function RecentDecisions({
  studyId,
  onNavigate,
}: {
  studyId: string | null;
  onNavigate?: () => void;
}) {
  const [items, setItems] = useState<AssetSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    function load() {
      wb.assets({ kind: 'decision', limit: 5 })
        .then((res) => {
          if (!cancelled) setItems(res.assets);
        })
        .catch(() => {
          // Silently ignore — the section just stays empty.
        });
    }
    load();
    const t = window.setInterval(load, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <NavSection title="Recent decisions">
      <ul className="grid gap-0.5">
        {items.slice(0, 5).map((a) => {
          const md = a.metadata ?? {};
          const decisionId = decisionIdOf(a);
          const recommendation =
            typeof md.recommendation === 'string' && md.recommendation
              ? md.recommendation
              : 'Committed decision';
          const scope = (md.scope ?? {}) as Record<string, unknown>;
          const studyParam =
            typeof scope.study_id === 'string' && scope.study_id
              ? scope.study_id
              : (studyId ?? '');
          const href = decisionId
            ? `/decision/${decisionId}${studyParam ? `?study=${studyParam}` : ''}`
            : `/assets/${a.asset_key_encoded}`;
          const shortLabel = truncate(
            recentDecisionLabel(scope, recommendation),
            60,
          );
          const committedAt =
            typeof md.committed_at === 'string' ? md.committed_at : '';
          const ago = relativeShort(committedAt);
          return (
            <li key={a.asset_key_encoded}>
              <Link
                href={href}
                onClick={onNavigate}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-snug text-slate-600 hover:bg-slate-100 hover:text-slate-950"
                title={recommendation}
              >
                <span className="min-w-0 flex-1 truncate line-clamp-1">
                  {shortLabel}
                </span>
                {ago ? (
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-slate-400">
                    {ago}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </NavSection>
  );
}

function recentDecisionLabel(
  scope: Record<string, unknown>,
  recommendation: string,
): string {
  const driver = typeof scope.driver_id === 'string' ? scope.driver_id : '';
  if (driver) return humaniseName(driver.replace(/-/g, '_'));
  const finding = typeof scope.finding_id === 'string' ? scope.finding_id : '';
  if (finding) return humaniseName(finding.replace(/-/g, '_'));
  return recommendation;
}

function relativeShort(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 60_000) return 'now';
    const m = Math.round(diffMs / 60_000);
    if (m < 60) return `${m}m`;
    const h = Math.round(diffMs / 3_600_000);
    if (h < 48) return `${h}h`;
    const day = Math.round(diffMs / 86_400_000);
    if (day < 14) return `${day}d`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
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

function decisionIdOf(asset: AssetSummary): string | undefined {
  if (asset.kind !== 'decision') return undefined;
  const md = asset.metadata ?? {};
  const fromMd = typeof md.decision_id === 'string' ? md.decision_id : null;
  if (fromMd) return fromMd;
  return asset.asset_key.at(-1) ?? undefined;
}

function truncate(value: string, max: number): string {
  if (!value) return value;
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function humaniseName(value: string): string {
  if (!value) return value;
  return value
    .replace(/_/g, ' ')
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase());
}

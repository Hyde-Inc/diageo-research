'use client';

/**
 * Global header nav for the focused single-job views.
 *
 * Goals:
 *   - Each focused page is reachable in one click from anywhere.
 *   - The current study is preserved across links via the `?study=`
 *     search param (matches what `useStudyData` reads).
 *   - The strip stays narrow visually so it can sit alongside the small
 *     "ADC Research" brand without dominating the chrome.
 *
 * The Workbench link stays last and is visually demoted slightly so
 * the audience reads the focused views as the primary entrypoints,
 * with the workbench available as a power-user surface.
 */

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  Compass,
  Grid2X2,
  HelpCircle,
  Lightbulb,
  ListChecks,
  MessageCircle,
  Settings2,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
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
    href: '/evidence',
    label: 'Evidence',
    Icon: HelpCircle,
    match: '/evidence',
    tone: 'primary',
  },
  { href: '/setup', label: 'Setup', Icon: Settings2, tone: 'primary' },
  { href: '/ask', label: 'Ask', Icon: MessageCircle, tone: 'primary' },
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

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      <ul className="flex min-w-0 items-center gap-1">
        {NAV.map((item) => {
          const match = item.match ?? item.href;
          const active = pathname === item.href || pathname.startsWith(`${match}/`);
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
  );
}

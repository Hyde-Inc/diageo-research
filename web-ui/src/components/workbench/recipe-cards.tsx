'use client';

/**
 * Recipe-cards strip.
 *
 * Currently a study has exactly one recipe (its prereg + spec grid),
 * but UI treats it as a "selected card" so the audience can see that
 * additional recipes — alternative pre-registrations or cell grids —
 * could be added next to it. The "+ add recipe" affordance is
 * deliberately subtle and disabled, signposting "coming next" without
 * making the page feel broken.
 */

import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { StudyDetail, StudySummary } from './types';

export type RecipeCardData = {
  id: string;
  title: string;
  cellsComplete: number;
  cellsTotal: number;
  status: 'pending' | 'running' | 'complete' | 'error';
  axesCount: number;
};

export function RecipeCards({
  detail,
  summary,
  selectedRecipeId,
  onSelectRecipe,
}: {
  detail: StudyDetail | null;
  summary: StudySummary | null;
  selectedRecipeId: string | null;
  onSelectRecipe: (id: string) => void;
}) {
  // For now there is exactly one recipe per study. The cards layout is
  // future-proofed: when the data model supports alternative prereg/spec
  // pairs we can enumerate them here without changing callers.
  const cards: RecipeCardData[] = detail
    ? [
        {
          id: detail.id,
          title: detail.name,
          cellsComplete: summary?.n_complete ?? detail.cells.length,
          cellsTotal: summary?.n_cells ?? detail.cells.length,
          status: detail.status,
          axesCount: countAxes(detail),
        },
      ]
    : [];

  const isPlaceholder = cards.length === 0;

  return (
    <section
      aria-label="Recipes"
      className="rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm shadow-slate-950/[0.04]"
      data-testid="recipe-cards"
    >
      <header className="flex items-baseline justify-between gap-3 px-1 pb-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold tracking-tight text-slate-900">
            Recipes
          </h3>
          <p className="text-[11px] text-slate-500">
            One recipe = one prereg + cell grid running in parallel.
          </p>
        </div>
      </header>
      <div className="grid gap-2 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
        {cards.map((card) => (
          <RecipeCard
            key={card.id}
            card={card}
            selected={card.id === selectedRecipeId}
            onSelect={() => onSelectRecipe(card.id)}
          />
        ))}
        {isPlaceholder ? (
          <div className="grid gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50/80 px-3 py-3 text-xs text-slate-500">
            <span className="font-mono uppercase tracking-wider text-[10px]">
              recipe
            </span>
            <span>Pick a study to see its recipe.</span>
          </div>
        ) : null}
        <button
          type="button"
          disabled
          aria-disabled="true"
          title="Adding a second recipe lands in the next iteration."
          className="grid place-items-center gap-1 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-3 py-3 text-[11px] text-slate-500 transition-colors hover:border-slate-400 hover:bg-white disabled:cursor-not-allowed"
        >
          <Plus className="h-4 w-4 text-slate-400" />
          <span>+ add recipe</span>
          <span className="font-mono text-[9px] uppercase tracking-wider text-slate-400">
            coming next
          </span>
        </button>
      </div>
    </section>
  );
}

function RecipeCard({
  card,
  selected,
  onSelect,
}: {
  card: RecipeCardData;
  selected: boolean;
  onSelect: () => void;
}) {
  const pct = card.cellsTotal
    ? Math.round((card.cellsComplete / card.cellsTotal) * 100)
    : 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'group grid gap-2 rounded-xl border bg-white px-3 py-2.5 text-left shadow-sm transition-all',
        selected
          ? 'border-slate-950 ring-2 ring-slate-950/15'
          : 'border-slate-200 hover:border-slate-400',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
          recipe
        </span>
        <StatusDot status={card.status} />
      </div>
      <div className="grid gap-1">
        <div className="truncate text-sm font-semibold tracking-tight text-slate-900">
          {card.title}
        </div>
        <div className="font-mono text-[10px] text-slate-500">
          {card.cellsComplete}/{card.cellsTotal} cells · {card.axesCount}{' '}
          {card.axesCount === 1 ? 'axis' : 'axes'}
        </div>
      </div>
      <div className="grid gap-1">
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className={cn('absolute left-0 top-0 h-full rounded-full', progressTone(card.status))}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </button>
  );
}

function StatusDot({ status }: { status: RecipeCardData['status'] }) {
  const tone =
    status === 'complete'
      ? 'bg-emerald-500'
      : status === 'running'
        ? 'animate-pulse bg-blue-500'
        : status === 'error'
          ? 'bg-orange-500'
          : 'bg-slate-300';
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-600">
      <span className={cn('h-1.5 w-1.5 rounded-full', tone)} />
      {status}
    </span>
  );
}

function progressTone(status: RecipeCardData['status']): string {
  if (status === 'complete') return 'bg-emerald-500';
  if (status === 'running') return 'bg-blue-500';
  if (status === 'error') return 'bg-orange-500';
  return 'bg-slate-400';
}

function countAxes(detail: StudyDetail): number {
  const names = new Set<string>();
  for (const cell of detail.cells) {
    for (const k of Object.keys(cell.axes ?? {})) names.add(k);
  }
  return names.size;
}

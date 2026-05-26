import { cn } from '@/lib/utils';

export function PaneDeck({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('grid gap-4', className)} {...props}>
      {children}
    </div>
  );
}

export function PaneGrid({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('grid gap-4 lg:grid-cols-2 xl:grid-cols-4', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function PaneCard({
  title,
  meta,
  description,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  meta?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-2xl border border-slate-200 bg-white/95 text-slate-950 shadow-sm shadow-slate-950/[0.04]',
        className,
      )}
    >
      <header className="border-b border-slate-100 bg-slate-50/70 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <h3 className="text-sm font-semibold tracking-tight text-slate-900">
            {title}
          </h3>
          {meta ? (
            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500 shadow-sm">
              {meta}
            </span>
          ) : null}
        </div>
        {description ? (
          <p className="mt-1 text-[11px] leading-snug text-slate-500">
            {description}
          </p>
        ) : null}
      </header>
      <div className={cn('px-4 py-3', bodyClassName)}>{children}</div>
    </section>
  );
}

export function PaneEmpty({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-dashed border-slate-300 bg-slate-50/80 px-3 py-2 text-sm text-slate-500',
        className,
      )}
    >
      {children}
    </div>
  );
}

import { cn } from '@/lib/utils';

export function PaneDeck({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('grid gap-3', className)} {...props}>
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
      className={cn('grid gap-3 lg:grid-cols-2 xl:grid-cols-4', className)}
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
    <section className={cn('rounded-md border bg-card', className)}>
      <header className="border-b px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          {meta ? (
            <span className="text-[11px] text-muted-foreground">{meta}</span>
          ) : null}
        </div>
        {description ? (
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            {description}
          </p>
        ) : null}
      </header>
      <div className={cn('px-3 py-2.5', bodyClassName)}>{children}</div>
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
        'rounded-md border border-dashed bg-muted/20 px-3 py-2 text-sm text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}

import type { ReactNode } from 'react';

/**
 * The top of a page: a small mono label, the title, one optional line, and the page's own actions beside the title on
 * a wide screen. Kept short on purpose so the work starts near the top of the screen.
 */
export function PageHeader({ eyebrow, title, description, children }: { eyebrow?: string; title: string; description?: string; children?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
      <div className="min-w-0">
        {eyebrow ? <p className="mono-label mb-2 text-muted-foreground">{eyebrow}</p> : null}
        <h1 className="font-display text-3xl leading-9 font-bold sm:text-4xl sm:leading-10">{title}</h1>
        {description ? <p className="mt-3 max-w-[64ch] text-[0.9375rem] leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {children ? <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  );
}

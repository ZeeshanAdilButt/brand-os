import type { ReactNode } from 'react';

/**
 * The top of a page: the title, one optional line, and the page’s own actions beside the title on a wide screen.
 * Kept short on purpose so the work starts near the top of the screen.
 */
export function PageHeader({ title, description, children }: { eyebrow?: string; title: string; description?: string; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <h1 className="text-2xl leading-8 font-semibold sm:text-[1.75rem] sm:leading-9">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {children ? <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  );
}

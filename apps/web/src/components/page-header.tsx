import type { ReactNode } from 'react';

export function PageHeader({ eyebrow, title, description, children }: { eyebrow?: string; title: string; description?: string; children?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-3 border-b pb-6 sm:mb-10">
      {eyebrow ? <p className="label-caps text-link">{eyebrow}</p> : null}
      <h1 className="font-serif text-3xl font-semibold sm:text-4xl">{title}</h1>
      {description ? <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">{description}</p> : null}
      {children}
    </header>
  );
}

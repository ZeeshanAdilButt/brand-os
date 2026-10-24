'use client';

import { CircleCheck, ExternalLink, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ConnectorScope, ConnectorStep } from '@/lib/connectors';
import { cn } from '@/lib/utils';

/** A titled block of the drawer. */
export function Section({ title, hint, children, className }: { title: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('grid gap-3 border-t px-5 py-5 first:border-t-0 sm:px-6', className)}>
      <div className="grid gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <p className="text-xs leading-5 text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** A link that opens the platform's own page in a new tab. */
export function PlatformLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex h-10 w-fit max-w-full items-center gap-2 rounded-md border-[1.5px] border-border-strong bg-surface px-3.5 text-sm font-medium transition-colors duration-[120ms] hover:bg-accent hover:text-accent-foreground"
    >
      <span className="min-w-0 truncate">{children}</span>
      <ExternalLink aria-hidden className="size-4 shrink-0" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

/** Ordered steps in plain language. Each may carry the deep link to the platform's own page. */
export function StepList({ steps }: { steps: readonly ConnectorStep[] }) {
  return (
    <ol className="grid gap-4">
      {steps.map((step, i) => (
        <li key={step.title} className="flex gap-3">
          <span aria-hidden className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
            {i + 1}
          </span>
          <div className="grid min-w-0 gap-2">
            <p className="text-sm leading-6">
              <strong className="font-semibold">{step.title}.</strong> {step.body}
            </p>
            {step.linkUrl ? <PlatformLink href={step.linkUrl}>{step.linkLabel ?? 'Open the page'}</PlatformLink> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The access asked for, and why. Required items cannot be switched off; optional ones are checkboxes. */
export function ScopeList({ scopes, chosen, onToggle, idPrefix }: { scopes: readonly ConnectorScope[]; chosen?: ReadonlySet<string>; onToggle?(name: string, on: boolean): void; idPrefix: string }) {
  return (
    <ul className="grid gap-2">
      {scopes.map((scope, i) => {
        const id = `${idPrefix}-scope-${i}`;
        const optional = !scope.required && onToggle;
        return (
          <li key={scope.name} className="flex min-h-10 items-start gap-3 rounded-lg border bg-surface px-3 py-2.5">
            {optional ? (
              <input id={id} type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--primary)]" checked={chosen?.has(scope.name) ?? false} onChange={(e) => onToggle(scope.name, e.target.checked)} />
            ) : (
              <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
            )}
            <label htmlFor={optional ? id : undefined} className="grid min-w-0 gap-0.5 text-sm leading-5">
              <span className="flex flex-wrap items-center gap-x-2">
                <code className="font-mono text-xs break-all">{scope.name}</code>
                <span className="mono-label text-muted-foreground">{scope.required ? 'always' : 'optional'}</span>
              </span>
              <span className="text-muted-foreground">{scope.reason}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

export function Callout({ tone, children, title }: { tone: 'good' | 'warn' | 'info'; children: ReactNode; title?: string }) {
  const classes = tone === 'good' ? 'border-success/25 bg-success-subtle text-success' : tone === 'warn' ? 'border-warning/30 bg-warning-subtle text-warning' : 'border bg-muted text-foreground';
  return (
    <div role={tone === 'warn' ? 'alert' : 'status'} className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm leading-6', classes)}>
      {tone === 'good' ? <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" /> : tone === 'warn' ? <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" /> : null}
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className={tone === 'info' ? '' : 'text-foreground/85'}>{children}</div>
      </div>
    </div>
  );
}

/** A folded block for the less common things: the browser-agent guide, how to take access away, what was checked. */
export function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group rounded-lg border bg-surface">
      <summary className="flex min-h-10 cursor-pointer items-center px-3 text-sm font-medium">{title}</summary>
      <div className="grid gap-3 border-t px-3 py-3 text-sm leading-6">{children}</div>
    </details>
  );
}

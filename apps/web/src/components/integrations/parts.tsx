'use client';

import { Check, Copy, ExternalLink } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Copy text to the clipboard and say so. Falls back to a plain notice when the browser refuses. */
export function CopyButton({ text, label = 'Copy', copiedLabel = 'Copied', size = 'sm', variant = 'outline', className }: { text: string; label?: string; copiedLabel?: string; size?: 'sm' | 'default' | 'xs'; variant?: 'outline' | 'ghost' | 'default'; className?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      setState('failed');
    }
    window.setTimeout(() => setState('idle'), 2500);
  }
  return (
    <Button type="button" size={size} variant={variant} className={className} onClick={() => void copy()}>
      {state === 'done' ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span aria-live="polite">{state === 'done' ? copiedLabel : state === 'failed' ? 'Copy failed: select the text' : label}</span>
    </Button>
  );
}

/** A short numbered list with the link that opens the exact page in a new tab. */
export function GuideSteps({ steps, openUrl, openLabel }: { steps: string[]; openUrl?: string; openLabel?: string }) {
  return (
    <div className="grid gap-3">
      <ol className="grid gap-2 text-sm leading-6">
        {steps.map((step, i) => (
          <li key={step} className="flex gap-2.5">
            <span aria-hidden className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {openUrl ? (
        <a
          href={openUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex h-9 w-fit items-center gap-2 rounded-lg border border-input bg-surface px-3 text-sm font-medium transition-colors duration-[120ms] hover:bg-muted"
        >
          {openLabel ?? 'Open the page'}
          <ExternalLink aria-hidden className="size-4" />
        </a>
      ) : null}
    </div>
  );
}

/** A labelled block inside a setup card. */
export function Block({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('grid gap-2', className)}>
      <h4 className="text-sm font-semibold">{title}</h4>
      {children}
    </section>
  );
}

/** Where a saved-but-unused value is shown: its last four characters and a plain statement that it is not used yet. */
export function SavedNote({ hint, what, onRemove, busy }: { hint: string; what: string; onRemove(): void; busy: boolean }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-success/25 bg-success-subtle px-3 py-2 text-sm text-success">
      <Check aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <strong className="font-semibold">Saved. Not used yet.</strong> {what} ends in <span className="font-mono">{hint}</span>. It is encrypted, never shown again and nothing sends it anywhere.
      </span>
      {confirm ? (
        <span className="flex items-center gap-2 text-foreground">
          Wipe it?
          <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={onRemove}>
            Remove
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(false)}>
            Keep
          </Button>
        </span>
      ) : (
        <Button type="button" size="sm" variant="outline" className="text-foreground" onClick={() => setConfirm(true)}>
          Remove
        </Button>
      )}
    </div>
  );
}

'use client';

import { Check, Copy } from 'lucide-react';
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

/** A labelled block inside a setup card. */
export function Block({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('grid gap-2', className)}>
      <h4 className="text-sm font-semibold">{title}</h4>
      {children}
    </section>
  );
}

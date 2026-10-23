'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Used as the accessible name when the label is only an icon. */
  title?: string;
  disabled?: boolean;
}

/** A small set of mutually exclusive choices drawn as one control. Each button says whether it is pressed. */
export function Segmented<T extends string>({ label, value, options, onChange, className }: { label: string; value: T; options: SegmentedOption<T>[]; onChange(value: T): void; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex rounded-xl border-[1.5px] border-border-strong bg-surface p-0.5', className)}>
      {options.map((option) => {
        const pressed = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:text-muted-foreground/60',
              pressed ? 'bg-solid font-semibold text-solid-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

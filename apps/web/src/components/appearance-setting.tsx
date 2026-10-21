'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { THEME_LABELS, useThemePreference, type ThemePreference } from '@/lib/theme';
import { cn } from '@/lib/utils';

const OPTIONS: { value: ThemePreference; icon: typeof Sun }[] = [
  { value: 'system', icon: Monitor },
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
];

/** Theme choice as a radio group. Persists in this browser only. */
export function AppearanceSetting() {
  const [preference, setPreference] = useThemePreference();
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-grid grid-cols-3 gap-1 rounded-lg border bg-muted p-1">
      {OPTIONS.map(({ value, icon: Icon }) => {
        const selected = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setPreference(value)}
            className={cn(
              'inline-flex h-9 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-medium transition-colors',
              selected ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon aria-hidden className="size-4" />
            {THEME_LABELS[value]}
          </button>
        );
      })}
    </div>
  );
}

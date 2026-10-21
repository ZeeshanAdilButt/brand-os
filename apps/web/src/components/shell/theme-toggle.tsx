'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { nextTheme, THEME_LABELS, useThemePreference } from '@/lib/theme';

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;

/** Cycles System, Light, Dark. The label always names the current choice and the next one. */
export function ThemeToggle() {
  const [preference, setPreference] = useThemePreference();
  const Icon = ICONS[preference];
  const next = nextTheme(preference);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => setPreference(next)}
      aria-label={`Theme: ${THEME_LABELS[preference]}. Switch to ${THEME_LABELS[next]}.`}
      title={`Theme: ${THEME_LABELS[preference]} (click for ${THEME_LABELS[next]})`}
    >
      <Icon aria-hidden />
    </Button>
  );
}

'use client';

import { CornerDownLeft, Home, Monitor, Moon, Sun } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { NAV_ITEMS } from '@/lib/nav';
import { useThemePreference, type ThemePreference } from '@/lib/theme';

const THEME_COMMANDS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Use light theme', icon: Sun },
  { value: 'dark', label: 'Use dark theme', icon: Moon },
  { value: 'system', label: 'Match system theme', icon: Monitor },
];

/** Cmd/Ctrl+K palette. Only commands that work today: jump to a page, change theme. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [, setTheme] = useThemePreference();

  const go = useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href);
    },
    [onOpenChange, router],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Jump to a page or change the theme"
      showCloseButton={false}
      className="top-[16%] translate-y-0 sm:max-w-xl"
    >
      <CommandInput placeholder="Jump to a page or run a command" />
      <CommandList>
        <CommandEmpty>No matching command.</CommandEmpty>
        <CommandGroup heading="Go to">
          <CommandItem value="Overview home" onSelect={() => go('/')}>
            <Home aria-hidden />
            Overview
          </CommandItem>
          {NAV_ITEMS.map(({ href, label, description, icon: Icon }) => (
            <CommandItem key={href} value={`${label} ${description}`} onSelect={() => go(href)}>
              <Icon aria-hidden />
              {label}
              <span className="ml-auto hidden truncate pl-4 text-xs text-muted-foreground sm:inline">{description}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Appearance">
          {THEME_COMMANDS.map(({ value, label, icon: Icon }) => (
            <CommandItem
              key={value}
              value={label}
              onSelect={() => {
                setTheme(value);
                onOpenChange(false);
              }}
            >
              <Icon aria-hidden />
              {label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
      <div className="flex items-center justify-end gap-1.5 border-t px-3 py-2 text-xs text-muted-foreground">
        <CornerDownLeft aria-hidden className="size-3" /> to select, Esc to close
      </div>
    </CommandDialog>
  );
}

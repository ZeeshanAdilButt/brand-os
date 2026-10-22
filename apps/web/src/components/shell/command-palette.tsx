'use client';

import { CornerDownLeft, Monitor, Moon, Sun } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { api } from '@/lib/api-client';
import { buildCommands, type Command } from '@/lib/commands';
import { useThemePreference, type ThemePreference } from '@/lib/theme';

const GROUP_ORDER: Command['group'][] = ['Articles', 'Go to', 'Create', 'Platforms', 'Settings', 'Appearance'];
const THEME_COMMANDS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Use light theme', icon: Sun },
  { value: 'dark', label: 'Use dark theme', icon: Moon },
  { value: 'system', label: 'Match system theme', icon: Monitor },
];

/**
 * Ctrl+K: jump to an article, a platform, a setting or a screen, or start something harmless (a new article, the theme).
 * The list is built from `buildCommands`, which has no command that approves, declines or publishes anything: those
 * are done only on the post itself, in the app.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const [theme, setTheme] = useThemePreference();
  const [articles, setArticles] = useState<{ id: string; title: string }[]>([]);
  const current = /^\/articles\/([0-9a-f-]{36})/i.exec(pathname)?.[1] ?? null;

  useEffect(() => {
    if (!open) return;
    let live = true;
    void api<{ articles: { id: string; title: string }[] }>('/api/articles?limit=30').then((result) => {
      if (live && result.ok) setArticles(result.data.articles.map((a) => ({ id: a.id, title: a.title })));
    });
    return () => {
      live = false;
    };
  }, [open]);

  const commands = useMemo(() => buildCommands({ articles, currentArticleId: current }), [articles, current]);

  const go = useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href);
    },
    [onOpenChange, router],
  );

  async function run(command: Command) {
    if (command.href) return go(command.href);
    onOpenChange(false);
    if (command.action === 'toggle-theme') setTheme(theme === 'dark' ? 'light' : 'dark');
    if (command.action === 'new-article') {
      const result = await api<{ id: string }>('/api/articles', { method: 'POST', json: {} });
      if (result.ok) router.push(`/articles/${result.data.id}`);
    }
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command palette" description="Jump to an article, a platform or a setting" showCloseButton={false} className="top-[16%] translate-y-0 sm:max-w-xl">
      <CommandInput placeholder="Search articles, platforms, settings" />
      <CommandList>
        <CommandEmpty>No match. Try a platform name or the title of an article.</CommandEmpty>
        {GROUP_ORDER.map((group) => {
          const inGroup = commands.filter((c) => c.group === group);
          if (inGroup.length === 0) return null;
          return (
            <CommandGroup key={group} heading={group}>
              {inGroup.map((command) => (
                <CommandItem key={command.id} value={`${command.label} ${command.hint ?? ''} ${command.keywords ?? ''}`} onSelect={() => void run(command)}>
                  {command.label}
                  {command.hint ? <span className="ml-auto hidden truncate pl-4 text-xs text-muted-foreground sm:inline">{command.hint}</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
        <CommandGroup heading="Theme">
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

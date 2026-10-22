'use client';

import { Menu, Search } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { AccountInfo } from './account-block';
import { Brand } from './brand';
import { CommandPalette } from './command-palette';
import { MobileNav } from './mobile-nav';
import { SidebarNav } from './sidebar-nav';
import { StatusChip } from './status-chip';
import { ThemeToggle } from './theme-toggle';

const noopSubscribe = () => () => {};
const isApplePlatform = () => /Mac|iPhone|iPad/.test(navigator.platform);

/** Application chrome: left rail, top bar, mobile drawer and command palette around the page. */
export function AppShell({ children, account }: { children: ReactNode; account?: AccountInfo }) {
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const apple = useSyncExternalStore(noopSubscribe, isApplePlatform, () => false);
  // The article studio (editor and preview side by side) and the publishing screens (three columns) need the full width; every other page keeps a readable column.
  const wide = /^\/articles\/[0-9a-f-]{36}(\/publish)?\/?$/i.test(usePathname() ?? '');

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // An editor that handled Ctrl+K itself (insert link) has already prevented the default.
      if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only z-[60] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:block">
        <SidebarNav {...(account ? { account } : {})} />
      </aside>

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-surface px-3 sm:px-6">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
          >
            <Menu aria-hidden />
          </Button>
          <div className="lg:hidden">
            <Brand />
          </div>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette"
            className="ml-auto flex h-10 items-center gap-2 rounded-lg border border-input bg-surface px-3 text-sm text-muted-foreground transition-colors duration-[120ms] hover:bg-muted hover:text-foreground sm:ml-0 sm:w-72 lg:w-96"
          >
            <Search aria-hidden className="size-4 shrink-0" />
            <span className="hidden flex-1 truncate text-left sm:inline">Search articles, platforms, settings</span>
            <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] sm:inline">
              {apple ? '⌘K' : 'Ctrl K'}
            </kbd>
          </button>

          <div className="flex items-center gap-1.5 sm:ml-auto">
            <StatusChip />
            <ThemeToggle />
          </div>
        </header>

        <main
          id="main"
          tabIndex={-1}
          className={cn('mx-auto w-full outline-none', wide ? 'max-w-none px-2 py-2 sm:px-4 sm:py-3' : 'max-w-[1200px] px-4 py-6 sm:px-6 lg:px-8')}
        >
          {children}
        </main>
      </div>

      <MobileNav open={navOpen} onOpenChange={setNavOpen} {...(account ? { account } : {})} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

'use client';

import { Menu, Search } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { isSidebarShortcut, isTypingTarget } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import type { AccountInfo } from './account-block';
import { Brand } from './brand';
import { CommandPalette } from './command-palette';
import { MobileNav } from './mobile-nav';
import { NORMAL_LAYOUT, ShellLayoutContext, ShellStepsContext, type ShellLayout, type ShellStep } from './shell-layout';
import { SIDEBAR_ID, SidebarNav } from './sidebar-nav';
import { StatusChip } from './status-chip';
import { ThemeToggle } from './theme-toggle';
import { useViewPrefs } from './view-prefs';

const noopSubscribe = () => () => {};
const isApplePlatform = () => /Mac|iPhone|iPad/.test(navigator.platform);
const isDesktop = () => typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 1024px)').matches;

/** Application chrome: left rail, top bar, mobile drawer and command palette around the page. */
export function AppShell({ children, account }: { children: ReactNode; account?: AccountInfo }) {
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [layout, setLayout] = useState<ShellLayout>(NORMAL_LAYOUT);
  const [steps, setSteps] = useState<ShellStep[] | null>(null);
  const { prefs, update } = useViewPrefs();
  const collapsed = prefs.sidebarCollapsed;
  const apple = useSyncExternalStore(noopSubscribe, isApplePlatform, () => false);
  // The article studio (editor and preview side by side) and the publishing screens (three columns) need the full width; every other page keeps a readable column.
  const pathname = usePathname() ?? '';
  const wide = layout.wide || /^\/articles\/[0-9a-f-]{36}(\/publish)?\/?$/i.test(pathname);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // An editor that handled Ctrl+K itself (insert link) has already prevented the default.
      if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      // Ctrl+\ folds the sidebar, but never while typing and never over an open dialog.
      if (event.defaultPrevented || !isSidebarShortcut(event) || isTypingTarget(event.target)) return;
      if (layout.hideSidebar || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      if (isDesktop()) update({ sidebarCollapsed: !collapsed });
      else setNavOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [collapsed, layout.hideSidebar, update]);

  return (
    <ShellLayoutContext.Provider value={setLayout}>
      <ShellStepsContext.Provider value={setSteps}>
      <TooltipProvider delayDuration={250} skipDelayDuration={300}>
        <div className="min-h-dvh">
          <a
            href="#main"
            className="sr-only z-[60] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
          >
            Skip to content
          </a>

          <aside
            id={SIDEBAR_ID}
            data-collapsed={collapsed}
            className={cn(
              'fixed inset-y-0 left-0 z-30 border-r border-sidebar-border bg-sidebar text-sidebar-foreground motion-safe:transition-[width] motion-safe:duration-200',
              layout.hideSidebar ? 'hidden' : 'hidden lg:block',
              collapsed ? 'w-[4.5rem]' : 'w-60',
            )}
          >
            <SidebarNav
              collapsed={collapsed}
              onToggleCollapsed={() => update({ sidebarCollapsed: !collapsed })}
              toggleHint={apple ? '⌘\\' : 'Ctrl+\\'}
              steps={steps}
              {...(account ? { account } : {})}
            />
          </aside>

          <div className={cn('motion-safe:transition-[padding-left] motion-safe:duration-200', layout.hideSidebar ? '' : collapsed ? 'lg:pl-[4.5rem]' : 'lg:pl-60')}>
            <header className={cn('sticky top-0 z-20 h-16 items-center gap-2 border-b bg-surface px-3 sm:px-6', layout.hideHeader ? 'hidden' : 'flex')}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={layout.hideSidebar ? undefined : 'lg:hidden'}
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
                className="ml-auto flex h-10 items-center gap-2 rounded-xl border border-input bg-surface px-3 text-sm text-muted-foreground transition-colors duration-[120ms] hover:bg-accent hover:text-foreground sm:ml-0 sm:w-72 lg:w-[22.5rem]"
              >
                <Search aria-hidden className="size-4 shrink-0" />
                <span className="hidden flex-1 truncate text-left sm:inline">Search articles, platforms, settings</span>
                <kbd className="hidden rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] sm:inline">
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
              className={cn('mx-auto w-full outline-none', wide ? 'max-w-none px-2 py-2 sm:px-4 sm:py-3' : cn('px-5 py-6 sm:px-8 lg:px-10 lg:pt-8', layout.fluid ? 'max-w-none' : 'max-w-[1120px]'))}
            >
              {children}
            </main>
          </div>

          <MobileNav open={navOpen} onOpenChange={setNavOpen} steps={steps} {...(account ? { account } : {})} />
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        </div>
      </TooltipProvider>
      </ShellStepsContext.Provider>
    </ShellLayoutContext.Provider>
  );
}

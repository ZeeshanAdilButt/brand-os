'use client';

import { Check, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Tip } from '@/components/ui/tooltip';
import { activeNavHref, NAV_FOOTER, NAV_ITEMS, type NavItem } from '@/lib/nav';
import { cn } from '@/lib/utils';
import { AccountBlock, type AccountInfo } from './account-block';
import { Brand } from './brand';
import type { ShellStep } from './shell-layout';

export const SIDEBAR_ID = 'app-sidebar';

function NavLink({ item, active, collapsed, onNavigate }: { item: NavItem; active: boolean; collapsed: boolean; onNavigate: (() => void) | undefined }) {
  const Icon = item.icon;
  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex h-11 items-center rounded-xl text-sm font-medium transition-colors duration-[120ms]',
        collapsed ? 'justify-center px-0' : 'gap-3 px-3',
        active ? 'bg-sidebar-active font-semibold text-white' : 'text-sidebar-muted hover:bg-sidebar-active/60 hover:text-sidebar-foreground',
      )}
    >
      {active ? <span aria-hidden className="absolute inset-y-2.5 left-0 w-1 rounded-full bg-sidebar-accent" /> : null}
      <Icon aria-hidden className={cn('size-[1.125rem] shrink-0', active && 'text-sidebar-accent')} />
      <span className={collapsed ? 'sr-only' : undefined}>{item.label}</span>
    </Link>
  );
  return collapsed ? <Tip label={item.label}>{link}</Tip> : link;
}

const STATE_WORDS = { done: ', done', current: ', current step', todo: ', not yet' } as const;

/**
 * The steps of the page's journey: done, current and upcoming. They show the way, they are not links, so nothing here
 * can skip an approval. Folded, each step is a small numbered dot whose label is read by a screen reader.
 */
function StepRail({ steps, collapsed }: { steps: ShellStep[]; collapsed: boolean }) {
  return (
    <div className="mt-6">
      {collapsed ? null : <p className="mono-label px-3 pb-2 text-sidebar-muted">Steps</p>}
      <ol aria-label="Steps" className="grid gap-1">
        {steps.map((step, i) => (
          <li
            key={step.id}
            aria-current={step.state === 'current' ? 'step' : undefined}
            title={collapsed ? step.label : undefined}
            className={cn(
              'flex min-h-11 items-center rounded-xl text-sm',
              collapsed ? 'justify-center px-0' : 'gap-3 px-3',
              step.state === 'current' ? 'bg-sidebar-active font-semibold text-white' : 'text-sidebar-muted',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'grid size-7 shrink-0 place-items-center rounded-full text-[0.8125rem]',
                step.state === 'done' && 'bg-sidebar-border text-sidebar-accent',
                step.state === 'current' && 'bg-sidebar-accent font-semibold text-forest',
                step.state === 'todo' && 'border-[1.5px] border-sidebar-muted/60',
              )}
            >
              {step.state === 'done' ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
            </span>
            <span className={collapsed ? 'sr-only' : undefined}>
              {step.label}
              <span className="sr-only">{STATE_WORDS[step.state]}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Brand, primary navigation, the page's steps when it has some, Settings near the bottom and one honest line about
 * approval. Shared by the desktop rail and the mobile drawer. With `collapsed` it is a slim icon rail whose labels are
 * tooltips; the drawer never is.
 */
export function SidebarNav({
  onNavigate,
  account,
  collapsed = false,
  onToggleCollapsed,
  toggleHint,
  steps,
}: {
  onNavigate?: () => void;
  account?: AccountInfo;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** The shortcut shown in the toggle's tooltip, for example "Ctrl+\". */
  toggleHint?: string;
  steps?: ShellStep[] | null;
}) {
  const pathname = usePathname();
  const current = activeNavHref(pathname);
  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  const toggle = onToggleCollapsed ? (
    <Tip label={toggleHint ? `${toggleLabel} (${toggleHint})` : toggleLabel}>
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        aria-controls={SIDEBAR_ID}
        aria-label={toggleLabel}
        className="grid size-10 shrink-0 place-items-center rounded-xl text-sidebar-muted transition-colors duration-[120ms] hover:bg-sidebar-active hover:text-sidebar-foreground"
      >
        {collapsed ? <PanelLeftOpen aria-hidden className="size-5" /> : <PanelLeftClose aria-hidden className="size-5" />}
      </button>
    </Tip>
  ) : null;

  return (
    <div data-surface="forest" className="flex h-full flex-col">
      <div className={cn('flex h-16 shrink-0 items-center', collapsed ? 'justify-center px-2' : 'justify-between gap-2 pr-3 pl-5')}>
        {collapsed ? null : <Brand onForest {...(onNavigate ? { onNavigate } : {})} />}
        {toggle}
      </div>
      <nav aria-label="Primary" className={cn('flex flex-1 flex-col overflow-y-auto py-3', collapsed ? 'px-2' : 'px-4')}>
        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <NavLink item={item} active={current === item.href} collapsed={collapsed} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
        {steps && steps.length > 0 ? <StepRail steps={steps} collapsed={collapsed} /> : null}
        <ul className="mt-auto flex flex-col gap-1 pt-4">
          {NAV_FOOTER.map((item) => (
            <li key={item.href}>
              <NavLink item={item} active={current === item.href} collapsed={collapsed} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      </nav>
      {account ? <AccountBlock account={account} collapsed={collapsed} /> : null}
      <div className={cn('shrink-0 border-t border-sidebar-border px-5 py-4', collapsed && 'sr-only')}>
        {account ? null : (
          <p className="font-mono text-xs leading-5 text-sidebar-muted">
            Local mode
            <br />
            Data stays on this computer.
          </p>
        )}
        <p className="mt-2 text-xs leading-5 text-sidebar-muted">Nothing goes public until you approve that exact post.</p>
      </div>
    </div>
  );
}

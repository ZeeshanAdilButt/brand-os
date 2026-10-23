'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Tip } from '@/components/ui/tooltip';
import { activeNavHref, NAV_FOOTER, NAV_ITEMS, type NavItem } from '@/lib/nav';
import { cn } from '@/lib/utils';
import { AccountBlock, type AccountInfo } from './account-block';
import { Brand } from './brand';

export const SIDEBAR_ID = 'app-sidebar';

function NavLink({ item, active, collapsed, onNavigate }: { item: NavItem; active: boolean; collapsed: boolean; onNavigate: (() => void) | undefined }) {
  const Icon = item.icon;
  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex h-10 items-center rounded-lg text-sm font-medium transition-colors duration-[120ms]',
        collapsed ? 'justify-center px-0' : 'gap-3 px-3',
        active ? 'bg-accent font-semibold text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {active ? <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" /> : null}
      <Icon aria-hidden className="size-[1.125rem] shrink-0" />
      <span className={collapsed ? 'sr-only' : undefined}>{item.label}</span>
    </Link>
  );
  return collapsed ? <Tip label={item.label}>{link}</Tip> : link;
}

/**
 * Brand, primary navigation, Settings near the bottom and one honest line about approval. Shared by the desktop rail
 * and the mobile drawer. With `collapsed` it is a slim icon rail whose labels are tooltips; the drawer never is.
 */
export function SidebarNav({
  onNavigate,
  account,
  collapsed = false,
  onToggleCollapsed,
  toggleHint,
}: {
  onNavigate?: () => void;
  account?: AccountInfo;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** The shortcut shown in the toggle's tooltip, for example "Ctrl+\". */
  toggleHint?: string;
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
        className="grid size-10 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors duration-[120ms] hover:bg-accent hover:text-foreground"
      >
        {collapsed ? <PanelLeftOpen aria-hidden className="size-5" /> : <PanelLeftClose aria-hidden className="size-5" />}
      </button>
    </Tip>
  ) : null;

  return (
    <div className="flex h-full flex-col">
      <div className={cn('flex h-14 shrink-0 items-center', collapsed ? 'justify-center px-2' : 'justify-between gap-2 pr-2 pl-4')}>
        {collapsed ? null : <Brand {...(onNavigate ? { onNavigate } : {})} />}
        {toggle}
      </div>
      <nav aria-label="Primary" className={cn('flex flex-1 flex-col overflow-y-auto py-3', collapsed ? 'px-2' : 'px-3')}>
        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <NavLink item={item} active={current === item.href} collapsed={collapsed} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
        <ul className="mt-auto flex flex-col gap-1 pt-4">
          {NAV_FOOTER.map((item) => (
            <li key={item.href}>
              <NavLink item={item} active={current === item.href} collapsed={collapsed} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      </nav>
      {account ? <AccountBlock account={account} collapsed={collapsed} /> : null}
      <p className={cn('shrink-0 border-t border-sidebar-border px-5 py-3.5 text-xs leading-5 text-muted-foreground', collapsed && 'sr-only')}>
        Nothing goes public until you approve that exact post.
      </p>
    </div>
  );
}

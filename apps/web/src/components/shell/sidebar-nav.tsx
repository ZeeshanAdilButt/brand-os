'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { activeNavHref, NAV_FOOTER, NAV_ITEMS, type NavItem } from '@/lib/nav';
import { cn } from '@/lib/utils';
import { AccountBlock, type AccountInfo } from './account-block';
import { Brand } from './brand';

function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate: (() => void) | undefined }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors duration-[120ms]',
        active ? 'bg-accent font-semibold text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {active ? <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" /> : null}
      <Icon aria-hidden className="size-[1.125rem] shrink-0" />
      {item.label}
    </Link>
  );
}

/** Brand, primary navigation, Settings near the bottom and one honest line about approval. Shared by the desktop rail and the mobile drawer. */
export function SidebarNav({ onNavigate, account }: { onNavigate?: () => void; account?: AccountInfo }) {
  const pathname = usePathname();
  const current = activeNavHref(pathname);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center px-4">
        <Brand {...(onNavigate ? { onNavigate } : {})} />
      </div>
      <nav aria-label="Primary" className="flex flex-1 flex-col overflow-y-auto px-3 py-3">
        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <NavLink item={item} active={current === item.href} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
        <ul className="mt-auto flex flex-col gap-1 pt-4">
          {NAV_FOOTER.map((item) => (
            <li key={item.href}>
              <NavLink item={item} active={current === item.href} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      </nav>
      {account ? <AccountBlock account={account} /> : null}
      <p className="shrink-0 border-t border-sidebar-border px-5 py-3.5 text-xs leading-5 text-muted-foreground">Nothing goes public until you approve that exact post.</p>
    </div>
  );
}

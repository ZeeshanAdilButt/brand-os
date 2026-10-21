'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { activeNavHref, NAV_ITEMS } from '@/lib/nav';
import { cn } from '@/lib/utils';
import { AccountBlock, type AccountInfo } from './account-block';
import { Brand } from './brand';

/** Brand, primary navigation and footer note. Shared by the desktop rail and the mobile drawer. */
export function SidebarNav({ onNavigate, account }: { onNavigate?: () => void; account?: AccountInfo }) {
  const pathname = usePathname();
  const current = activeNavHref(pathname);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center px-4">
        <Brand {...(onNavigate ? { onNavigate } : {})} />
      </div>
      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = current === href;
            return (
              <li key={href}>
                <Link
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group relative flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors',
                    active
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary transition-opacity',
                      active ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <Icon aria-hidden className={cn('size-[1.125rem] shrink-0', active && 'text-link')} />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {account ? <AccountBlock account={account} /> : null}
      <p className="shrink-0 border-t border-sidebar-border px-5 py-4 text-xs leading-relaxed text-muted-foreground">
        Nothing is published without your explicit approval.
      </p>
    </div>
  );
}

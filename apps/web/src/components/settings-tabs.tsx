'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/settings', label: 'General' },
  { href: '/settings/profile', label: 'Profile' },
  { href: '/settings/ai', label: 'AI' },
  { href: '/settings/agent-access', label: 'Agent access' },
] as const;

/** Sub-navigation inside Settings. */
export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="-mt-4 mb-8 flex gap-2 overflow-x-auto overflow-y-hidden border-b">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px inline-flex h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-4 text-[0.9375rem] font-medium transition-colors',
              active ? 'border-accent-warm font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

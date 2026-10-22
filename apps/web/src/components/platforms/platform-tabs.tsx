'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/platforms', label: 'Directory' },
  { href: '/platforms/integrations', label: 'Integrations' },
] as const;

/** Directory (what exists) and Integrations (how to connect it) live under Platforms. */
export function PlatformTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Platforms sections" className="mb-6 flex gap-1 border-b">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px rounded-t-md border-b-2 px-3.5 py-2 text-sm font-medium transition-colors duration-[120ms]',
              active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

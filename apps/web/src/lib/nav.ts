import { FileText, House, LayoutGrid, Send, BookOpen, Settings, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

/** The main places, in the order a person works: start, write, share, then the places that feed them. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Home', description: 'Your next step', icon: House },
  { href: '/articles', label: 'Articles', description: 'Write, import and edit', icon: FileText },
  { href: '/publishing', label: 'Publishing', description: 'Posts that need you, and results', icon: Send },
  { href: '/platforms', label: 'Platforms', description: 'Every place you can share, and your accounts', icon: LayoutGrid },
  { href: '/knowledge', label: 'Knowledge', description: 'Your private source material', icon: BookOpen },
];

/** Anchored near the bottom of the rail. */
export const NAV_FOOTER: readonly NavItem[] = [{ href: '/settings', label: 'Settings', description: 'Appearance, AI, agent access and your data', icon: Settings }];

export const ALL_NAV: readonly NavItem[] = [...NAV_ITEMS, ...NAV_FOOTER];

export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The one navigation item for this page: the longest address that matches. Home matches only the home page. */
export function activeNavHref(pathname: string): string | null {
  const matches = ALL_NAV.filter((item) => isActive(pathname, item.href)).sort((a, b) => b.href.length - a.href.length);
  return matches[0]?.href ?? null;
}

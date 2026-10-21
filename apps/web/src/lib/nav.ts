import { BookOpen, FileText, Plug, Send, Settings, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/articles', label: 'Articles', description: 'Write and manage technical articles', icon: FileText },
  { href: '/publishing', label: 'Publishing', description: 'Preview and publish to each destination', icon: Send },
  { href: '/knowledge', label: 'Knowledge', description: 'Your private source material', icon: BookOpen },
  { href: '/settings/connections', label: 'Connections', description: 'Accounts for publishing destinations', icon: Plug },
  { href: '/settings', label: 'Settings', description: 'Appearance, mode and system status', icon: Settings },
];

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The one navigation item for this page: the longest address that matches, so Connections does not also light up Settings. */
export function activeNavHref(pathname: string): string | null {
  const matches = NAV_ITEMS.filter((item) => isActive(pathname, item.href)).sort((a, b) => b.href.length - a.href.length);
  return matches[0]?.href ?? null;
}

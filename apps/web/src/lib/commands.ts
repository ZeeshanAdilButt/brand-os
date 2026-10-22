import { PLATFORMS, PLATFORM_IDS } from './catalog';
import { AREAS, AREA_LABELS } from './directory';

/**
 * What the command palette (Ctrl+K) can do: go somewhere, start something harmless, change how the app looks.
 * It cannot approve, decline or publish anything, and it cannot send. That is a rule of the list itself: a command
 * is either a link to a page or one of a closed set of local actions, and a test checks every label.
 */

export type LocalAction = 'new-article' | 'toggle-theme';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  group: 'Go to' | 'Articles' | 'Platforms' | 'Settings' | 'Create' | 'Appearance';
  /** A page of this app. */
  href?: string;
  /** One of a closed set of harmless local actions. */
  action?: LocalAction;
  keywords?: string;
}

/** Words no command label may start with. The palette navigates; the owner approves in the app, on the exact payload. */
export const FORBIDDEN_LABEL = /^\s*(approve|decline|deny|publish|send|post|submit|confirm|accept)\b/i;

export function buildCommands(options: { articles: { id: string; title: string }[]; currentArticleId?: string | null }): Command[] {
  const commands: Command[] = [
    { id: 'go-home', label: 'Home: your next step', group: 'Go to', href: '/', keywords: 'overview start progress' },
    { id: 'go-articles', label: 'Articles', group: 'Go to', href: '/articles' },
    { id: 'go-platforms', label: 'Platforms: every place you can share', group: 'Go to', href: '/platforms', keywords: 'directory destinations' },
    { id: 'go-publishing', label: 'Publishing: article, platforms and previews', group: 'Go to', href: '/publishing', keywords: 'drafts waiting status share' },
    { id: 'go-knowledge', label: 'Knowledge', group: 'Go to', href: '/knowledge' },
    { id: 'new-article', label: 'New article', hint: 'A blank article in the studio', group: 'Create', action: 'new-article' },
    { id: 'import-article', label: 'Import an article', hint: 'From a file, a page or a folder', group: 'Create', href: '/articles/import' },
    { id: 'settings', label: 'Settings', group: 'Settings', href: '/settings' },
    { id: 'settings-integrations', label: 'Integrations: connect your accounts', group: 'Settings', href: '/platforms/integrations', keywords: 'connections keys oauth' },
    { id: 'settings-ai', label: 'AI providers', group: 'Settings', href: '/settings/ai' },
    { id: 'settings-agent', label: 'Agent access', group: 'Settings', href: '/settings/agent-access', keywords: 'claude mcp' },
    { id: 'settings-profile', label: 'Profile', group: 'Settings', href: '/settings/profile' },
    { id: 'theme', label: 'Switch light and dark', group: 'Appearance', action: 'toggle-theme' },
  ];
  if (options.currentArticleId) {
    const id = options.currentArticleId;
    commands.unshift(
      { id: 'article-wizard', label: 'Choose platforms and preview this article', hint: 'Pick where it goes and see a preview of each', group: 'Articles', href: `/publishing?article=${id}` },
      { id: 'article-composer', label: 'Open the composer for this article', hint: 'All destinations side by side', group: 'Articles', href: `/articles/${id}/publish?view=composer` },
      { id: 'article-studio', label: 'Edit this article', group: 'Articles', href: `/articles/${id}` },
    );
  }
  for (const article of options.articles.slice(0, 30)) {
    commands.push({ id: `article-${article.id}`, label: article.title || 'Untitled article', hint: 'Open in the studio', group: 'Articles', href: `/articles/${article.id}` });
  }
  for (const id of PLATFORM_IDS) {
    const info = PLATFORMS[id];
    commands.push({ id: `platform-${id}`, label: `${info.name}: what it can do`, group: 'Platforms', href: `/platforms#${id}`, keywords: info.kind.replace('_', ' ') });
    commands.push({ id: `setup-${id}`, label: `Set up ${info.name}`, group: 'Platforms', href: `/platforms/integrations#${id}`, keywords: 'connect key account' });
  }
  for (const area of AREAS) {
    commands.push({ id: `area-${area}`, label: `Platforms: ${AREA_LABELS[area]}`, group: 'Platforms', href: `/platforms?area=${area}` });
  }
  return commands;
}

/** Plain substring-and-word match over label, hint and keywords. */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];
  return commands.filter((command) => {
    const haystack = `${command.label} ${command.hint ?? ''} ${command.keywords ?? ''} ${command.group}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

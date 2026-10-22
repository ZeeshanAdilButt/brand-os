import type { ArticleStatus } from './articles';
import { DIRECTORY, directoryStatus, type Area, type DirectoryEntry, type DirectoryStatus } from './directory';
import type { PlatformId } from './catalog';

/** What the article picker needs about one article. The list never loads bodies, so words are an estimate. */
export interface ArticleOption {
  id: string;
  title: string;
  status: ArticleStatus;
  /** Estimated from the length of the text (about 6 characters a word). 0 means there is no text yet. */
  words: number;
  updatedAt: string;
}

export const wordsFromChars = (chars: number): number => (chars <= 0 ? 0 : Math.round(chars / 6));

/** Newest first, the order the picker shows them in. Archived articles go last. */
export function sortArticles(options: readonly ArticleOption[]): ArticleOption[] {
  return [...options].sort((a, b) => {
    if ((a.status === 'archived') !== (b.status === 'archived')) return a.status === 'archived' ? 1 : -1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/** Articles that match every word typed, in the title. An empty search keeps them all. */
export function filterArticles(options: readonly ArticleOption[], query: string): ArticleOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return sortArticles(options).filter((o) => words.every((w) => (o.title || 'untitled article').toLowerCase().includes(w)));
}

/** The article to show first: the one asked for, else the newest with text, else the newest. Never an unknown id. */
export function pickInitialArticle(options: readonly ArticleOption[], asked: string | null | undefined): string | null {
  if (asked && options.some((o) => o.id === asked)) return asked;
  const sorted = sortArticles(options);
  return (sorted.find((o) => o.words > 0 && o.status !== 'archived') ?? sorted[0])?.id ?? null;
}

/** One row of the platform selector. */
export interface SelectorRow {
  entry: DirectoryEntry;
  status: DirectoryStatus;
  /** Which composer destination this is, when it can be chosen at all. Null means it cannot reach a preview or an approval. */
  composer: PlatformId | null;
  /** Why it cannot be chosen, in words. Null when it can. */
  blockedReason: string | null;
  /** What choosing it gets: send through the app, or preview and post by hand. */
  mode: 'publish' | 'manual' | 'none';
}

/**
 * Every entry of the directory as a selector row. An entry can be chosen only when it has a composer destination:
 * then it gets a live preview, and either publishing through the app (if it is built) or posting by hand. Anything
 * else stays visible with the reason and is never selectable, so it can never reach the approval queue.
 */
export function selectorRows(connected: ReadonlySet<PlatformId>): SelectorRow[] {
  return DIRECTORY.map((entry) => {
    const composer = entry.composer;
    const status = directoryStatus(entry, composer !== null && connected.has(composer));
    if (!composer) {
      return {
        entry,
        status,
        composer: null,
        blockedReason: entry.directoryOnly ? 'Directory only. No preview is built for it yet.' : `Not built yet${entry.roadmap ? ` (${entry.roadmap})` : ''}.`,
        mode: 'none' as const,
      };
    }
    return { entry, status, composer, blockedReason: null, mode: entry.adapter ? ('publish' as const) : ('manual' as const) };
  });
}

export function rowsInArea(rows: readonly SelectorRow[], area: Area | 'all', query: string): SelectorRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => (area === 'all' || r.entry.area === area) && words.every((w) => `${r.entry.name} ${r.entry.id} ${r.entry.summary}`.toLowerCase().includes(w)));
}

/** The steps shown above the areas on a narrow screen. */
export function workspaceProgress(input: { hasArticle: boolean; selected: number; prepared: number }): { id: 'article' | 'platforms' | 'previews'; label: string; state: 'done' | 'current' | 'todo' }[] {
  const articleDone = input.hasArticle;
  const platformsDone = input.selected > 0;
  const previewsDone = input.selected > 0 && input.prepared === input.selected;
  const current = !articleDone ? 'article' : !platformsDone ? 'platforms' : 'previews';
  const state = (id: 'article' | 'platforms' | 'previews', done: boolean) => (done && id !== current ? 'done' : id === current ? 'current' : 'todo');
  return [
    { id: 'article', label: 'Article', state: state('article', articleDone) },
    { id: 'platforms', label: 'Platforms', state: state('platforms', platformsDone) },
    { id: 'previews', label: 'Previews', state: previewsDone && current === 'previews' ? 'current' : state('previews', previewsDone) },
  ];
}

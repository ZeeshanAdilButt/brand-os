import type { ArticleStatus } from './articles';
import { AREAS, DIRECTORY, directoryStatus, type Area, type DirectoryEntry, type DirectoryStatus } from './directory';
import { KIND_LABELS, PLATFORMS, type PlatformId } from './catalog';

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

/** The short category names the selector's tabs use. The long names stay on the Platforms directory. */
export const SHORT_AREA_LABELS: Record<Area, string> = {
  blogs: 'Blogs',
  social: 'Social',
  communities: 'Communities',
  video: 'Video',
  conferences: 'Talks',
  editorial: 'Editorial',
  launches: 'Launches',
  aggregators: 'Aggregators',
};

/** How many entries each category holds, for the counts on the tabs. */
export function areaCounts(rows: readonly SelectorRow[]): Record<Area, number> {
  const counts = Object.fromEntries(AREAS.map((a) => [a, 0])) as Record<Area, number>;
  for (const row of rows) counts[row.entry.area] += 1;
  return counts;
}

/** The category to show first: where the first suggestion lives, else the first category that has anything. */
export function startArea(rows: readonly SelectorRow[], suggested: readonly PlatformId[]): Area {
  const first = suggested.map((id) => rows.find((r) => r.composer === id)).find(Boolean);
  return first?.entry.area ?? AREAS.find((a) => rows.some((r) => r.entry.area === a)) ?? 'blogs';
}

/** Two or three letters for a platform's tile, so a row can be recognised before it is read. */
export function monogramOf(name: string): string {
  // "DEV.to" is one word whose first part is the mark: DEV.
  const words = name.split(/\s+/).map((w) => w.split('.')[0] ?? '').map((w) => w.replace(/[^A-Za-z0-9]/g, '')).filter(Boolean);
  if (words.length === 0) return '?';
  const [first, second] = words as [string, string?];
  if (second) return (first.charAt(0) + second.charAt(0)).toUpperCase();
  if (first === first.toUpperCase() && first.length <= 4) return first;
  return first.charAt(0).toUpperCase() + first.charAt(1).toLowerCase();
}

/**
 * The state of a row in a word or two, with whether it asks for the person's attention (set up, connect). A platform that
 * is ready says nothing: being ready is the normal state and needs no badge.
 */
export function rowState(row: SelectorRow): { label: string; attention: boolean } {
  switch (row.status) {
    case 'available_now':
      return { label: '', attention: false };
    case 'needs_connection': {
      const auth = row.composer ? PLATFORMS[row.composer].authKind : 'none';
      if (row.composer === 'site') return { label: 'Set up', attention: true };
      const label = auth === 'api_key' ? 'Needs key' : auth === 'personal_access_token' ? 'Needs token' : auth === 'oauth' ? 'Needs sign-in' : auth === 'app_password' ? 'Needs password' : 'Set up';
      return { label, attention: true };
    }
    case 'preview_only':
      return { label: 'Preview', attention: false };
    case 'manual_only':
      return { label: 'Manual', attention: false };
    case 'planned':
      return { label: 'Planned', attention: false };
  }
}

/** The part of a catalog format worth a line: "Markdown (with Liquid tags)" is "Markdown", "Rich text, pasted" is "Rich text". */
const shortFormat = (format: string): string => (format.split('(')[0] ?? format).split(',')[0]!.trim();

/**
 * One real fact about a platform, from the catalog: the format it takes and the limit or feature that matters most.
 * "Markdown, canonical link", "3,000 characters, threads". An entry that cannot be chosen says why instead.
 */
export function platformFact(row: SelectorRow): string {
  if (row.blockedReason) return row.blockedReason;
  const info = row.composer ? PLATFORMS[row.composer] : null;
  if (!info) return row.entry.summary;
  const format = info.capabilities.formats[0] ? shortFormat(info.capabilities.formats[0]) : KIND_LABELS[info.kind];
  if (info.kind === 'short_form') {
    const size = info.limits.body ? `${info.limits.body.toLocaleString('en')} characters` : format;
    return `${size} · ${info.limits.thread ? 'threads' : 'single post'}`;
  }
  if (info.kind === 'long_form') return info.capabilities.canonicalUrl ? `${format} · canonical link` : format;
  const title = info.limits.title ? ` · title up to ${info.limits.title}` : '';
  return info.capabilities.formats[0] ? `${shortFormat(info.capabilities.formats[0])}${title}` : format;
}

export interface JourneyStep {
  id: 'article' | 'platforms' | 'approve' | 'share';
  label: string;
  state: 'done' | 'current' | 'todo';
}

/**
 * The four steps of publishing, for the rail in the sidebar: the post is chosen, platforms are picked and their previews
 * ready, every chosen post is decided (approved or published) one at a time, and the live links are shared. The first
 * step not done is the current one.
 */
export function journeySteps(input: { selected: number; prepared: number; decided: number; published: number }): JourneyStep[] {
  const platformsDone = input.selected > 0 && input.prepared >= input.selected;
  const approveDone = platformsDone && input.decided >= input.selected;
  const shareDone = approveDone && input.published >= input.selected;
  const done = [true, platformsDone, approveDone, shareDone];
  const current = done.indexOf(false);
  const labels: Pick<JourneyStep, 'id' | 'label'>[] = [
    { id: 'article', label: 'Post chosen' },
    { id: 'platforms', label: 'Pick platforms' },
    { id: 'approve', label: 'Approve each' },
    { id: 'share', label: 'Share the links' },
  ];
  return labels.map((l, i) => ({ ...l, state: done[i] ? 'done' : i === current ? 'current' : 'todo' }));
}

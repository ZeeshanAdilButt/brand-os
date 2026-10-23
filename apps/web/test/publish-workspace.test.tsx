// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArticlePicker } from '../src/components/publish/workspace/article-picker';
import { PlatformSelector } from '../src/components/publish/workspace/platform-selector';
import { ExpandedPreview, type ExpandEntry } from '../src/components/publish/workspace/preview-expand';
import { PublishWorkspace } from '../src/components/publish/workspace/workspace';
import { ViewPrefsProvider } from '../src/components/shell/view-prefs';
import { NORMAL_LAYOUT, ShellLayoutContext, type ShellLayout } from '../src/components/shell/shell-layout';
import { DEFAULT_VIEW_PREFS, type ViewPrefs } from '../src/lib/view-prefs';
import { DIRECTORY } from '../src/lib/directory';
import { PLATFORM_IDS, PLATFORMS, RECOMMENDED_ORDER, type DestinationDTO, type PlatformDraftDTO, type PlatformId } from '../src/lib/publishing';
import { filterArticles, pickInitialArticle, rowsInArea, selectorRows, sortArticles, workspaceProgress, wordsFromChars, type ArticleOption } from '../src/lib/publish-workspace';
import { loadRemembered } from '../src/lib/wizard-state';

afterEach(cleanup);

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const A3 = '33333333-3333-4333-8333-333333333333';

const ARTICLES: ArticleOption[] = [
  { id: A1, title: 'Why the write path stalls', status: 'draft', words: 1200, updatedAt: '2026-10-21T10:00:00.000Z' },
  { id: A2, title: 'A short note on retries', status: 'ready', words: 300, updatedAt: '2026-10-22T10:00:00.000Z' },
  { id: A3, title: 'Empty draft', status: 'draft', words: 0, updatedAt: '2026-10-23T10:00:00.000Z' },
];

describe('workspace helpers', () => {
  it('sorts newest first with archived last, and filters by every word typed', () => {
    const list = sortArticles([...ARTICLES, { id: 'x', title: 'Old archived', status: 'archived', words: 10, updatedAt: '2026-12-01T00:00:00.000Z' }]);
    expect(list.map((a) => a.id)).toEqual([A3, A2, A1, 'x']);
    expect(filterArticles(ARTICLES, 'write stalls').map((a) => a.id)).toEqual([A1]);
    expect(filterArticles(ARTICLES, 'nothing like this')).toEqual([]);
    expect(filterArticles(ARTICLES, '').length).toBe(3);
  });

  it('starts from the article asked for, else the newest with text, and never an unknown id', () => {
    expect(pickInitialArticle(ARTICLES, A1)).toBe(A1);
    expect(pickInitialArticle(ARTICLES, 'not-an-article')).toBe(A2);
    expect(pickInitialArticle([], null)).toBeNull();
    expect(wordsFromChars(0)).toBe(0);
    expect(wordsFromChars(600)).toBe(100);
  });

  it('offers every directory entry, and only entries with a destination can be chosen', () => {
    const rows = selectorRows(new Set());
    expect(rows).toHaveLength(DIRECTORY.length);
    const chosen = rows.filter((r) => r.composer !== null);
    expect(chosen.map((r) => r.composer).sort()).toEqual([...PLATFORM_IDS].sort());
    for (const row of rows.filter((r) => r.composer === null)) {
      expect(row.blockedReason, row.entry.id).toBeTruthy();
      expect(row.mode).toBe('none');
    }
    // Only the built adapters publish through the app; the rest are for previewing and posting by hand.
    expect(rows.filter((r) => r.mode === 'publish').map((r) => r.composer).sort()).toEqual(['devto', 'hashnode', 'site']);
    expect(rowsInArea(rows, 'social', '').every((r) => r.entry.area === 'social')).toBe(true);
    expect(rowsInArea(rows, 'all', 'hacker').map((r) => r.entry.id)).toContain('hackernews');
  });

  it('says where the person is: article, platforms, previews', () => {
    expect(workspaceProgress({ hasArticle: true, selected: 0, prepared: 0 }).map((p) => p.state)).toEqual(['done', 'current', 'todo']);
    expect(workspaceProgress({ hasArticle: true, selected: 2, prepared: 1 }).map((p) => p.state)).toEqual(['done', 'done', 'current']);
    expect(workspaceProgress({ hasArticle: false, selected: 0, prepared: 0 }).map((p) => p.state)).toEqual(['current', 'todo', 'todo']);
  });
});

describe('the article picker', () => {
  it('shows the chosen article with its status and size, searches, and chooses', () => {
    const onSelect = vi.fn();
    render(<ArticlePicker articles={ARTICLES} selectedId={A1} onSelect={onSelect} />);
    expect(screen.getByTestId('selected-article').textContent).toBe('Why the write path stalls');
    expect(screen.getByText(/about 1,200 words/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /change/i }));
    const search = screen.getByLabelText('Search your articles');
    fireEvent.change(search, { target: { value: 'retries' } });
    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(1);
    fireEvent.click(options[0]!);
    expect(onSelect).toHaveBeenCalledWith(A2);
  });

  it('says so when there are no articles', () => {
    render(<ArticlePicker articles={[]} selectedId={null} onSelect={() => undefined} />);
    expect(screen.getByText(/You have no articles yet/)).toBeTruthy();
  });
});

describe('the platform selector', () => {
  const rows = selectorRows(new Set());
  const none = new Set<PlatformId>();

  it('lists every platform and marks the ones that are not built yet, never fake-enabled', () => {
    const onToggle = vi.fn();
    render(<PlatformSelector rows={rows} selected={none} busy={none} onToggle={onToggle} recommendations={[]} />);
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(DIRECTORY.length);
    const disabled = boxes.filter((b) => b.disabled);
    expect(disabled).toHaveLength(DIRECTORY.length - PLATFORM_IDS.length);
    for (const box of disabled) fireEvent.click(box);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Not built yet|Directory only/).length).toBe(disabled.length);
  });

  it('chooses a platform that can be previewed, on click', () => {
    const onToggle = vi.fn();
    render(<PlatformSelector rows={rows} selected={none} busy={none} onToggle={onToggle} recommendations={[]} />);
    fireEvent.click(screen.getByLabelText(/^DEV\.to/));
    expect(onToggle).toHaveBeenCalledWith('devto');
    expect(screen.getAllByText('Preview here, post by hand').length).toBeGreaterThan(0);
  });

  it('filters by category tab and by search', () => {
    render(<PlatformSelector rows={rows} selected={none} busy={none} onToggle={() => undefined} recommendations={[]} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Video' }));
    expect(screen.getByLabelText(/YouTube/)).toBeTruthy();
    expect(screen.queryByLabelText(/^DEV\.to/)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    fireEvent.change(screen.getByLabelText('Search platforms'), { target: { value: 'mastodon' } });
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search platforms'), { target: { value: 'zzzz' } });
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
  });

  it('shows recommended chips with the reason, and toggles from them', () => {
    const onToggle = vi.fn();
    render(
      <PlatformSelector
        rows={rows}
        selected={new Set<PlatformId>(['site'])}
        busy={none}
        onToggle={onToggle}
        recommendations={[
          { platform: 'site', reason: 'Your own site is the canonical home: publish there first.' },
          { platform: 'devto', reason: 'A technical article suits DEV.to readers.' },
        ]}
      />,
    );
    const group = screen.getByRole('region', { name: /recommended for this article/i });
    const site = within(group).getByRole('button', { name: 'Personal site' });
    expect(site.getAttribute('aria-pressed')).toBe('true');
    expect(site.getAttribute('title')).toMatch(/canonical home/);
    fireEvent.click(within(group).getByRole('button', { name: 'DEV.to' }));
    expect(onToggle).toHaveBeenCalledWith('devto');
  });
});

// ---- the whole workspace, with a stubbed server ---------------------------------------------------------------------

const PAYLOAD = { title: 'Why the write path stalls', description: 'Short.', tags: ['go'], canonicalUrl: 'https://example-blog.dev/p/stalls', coverImageUrl: null, series: null, bodyMarkdown: 'Body text of the article.' };

function draft(platform: PlatformId, over: Partial<PlatformDraftDTO> = {}): PlatformDraftDTO {
  return {
    id: `d-${platform}`,
    articleId: A1,
    platform,
    status: 'draft',
    stale: false,
    payload: { ...PAYLOAD, title: `${PAYLOAD.title} (${platform})` },
    payloadSha256: 'a'.repeat(64),
    requestPreview: '{}',
    tagReport: { original: [], sent: [], changes: [] },
    lint: [],
    account: null,
    sourceRevision: 1,
    remoteId: null,
    remoteUrl: null,
    remotePreviewUrl: null,
    failureKind: null,
    failureMessage: null,
    nextAction: null,
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
    stagedAt: null,
    publishedAt: null,
    approval: null,
    attempts: [],
    generated: PAYLOAD,
    divergence: { edited: [], fromSource: [] },
    extras: {},
    remoteInfo: null,
    publishedVia: null,
    editedAt: null,
    editCount: 0,
    canonical: null,
    ...over,
  };
}

const dest = (platform: PlatformId, added = false, withDraft = false): DestinationDTO => ({
  platform,
  info: PLATFORMS[platform],
  connection: null,
  draft: withDraft ? draft(platform) : null,
  added,
  position: RECOMMENDED_ORDER.indexOf(platform),
  siteReady: null,
});

const ALL = (added: PlatformId[] = [], articleId = A1): DestinationDTO[] => PLATFORM_IDS.map((p) => ({ ...dest(p, added.includes(p), added.includes(p)), draft: added.includes(p) ? { ...draft(p), articleId } : null }));

function serve(state: { added: Set<PlatformId> }) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? (init?.body ? 'POST' : 'GET');
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
      if (url.endsWith('/destinations') && method === 'POST') {
        state.added.add((body as { platform: PlatformId }).platform);
        return json({ platform: (body as { platform: string }).platform, position: 0 }, 201);
      }
      if (url.endsWith('/destinations') && method === 'GET') return json({ destinations: ALL([...state.added], url.includes(A2) ? A2 : A1) });
      if (url.endsWith('/api/platform-drafts') && method === 'POST') return json(draft((body as { platform: PlatformId }).platform), 201);
      if (/\/destinations\/\w+$/.test(url) && method === 'DELETE') {
        state.added.delete(url.split('/').at(-1) as PlatformId);
        return json({ removed: true });
      }
      if (/\/api\/articles\/[0-9a-f-]{36}$/.test(url)) return json({ id: url.split('/').at(-1), title: 'A short note on retries', description: '', tags: [], canonicalUrl: null, bodyMarkdown: 'Retry with backoff.', status: 'ready', revision: 1 });
      return json({});
    }),
  );
  return calls;
}

const article = (id = A1) => ({ id, title: 'Why the write path stalls', description: 'Short.', tags: ['go'], canonicalUrl: 'https://example-blog.dev/p/stalls', bodyMarkdown: 'The write path stalls when the log fills faster than the disk can flush it. '.repeat(30) });

beforeEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('the publishing workspace', () => {
  it('starts with the three areas, and no way to review before something is chosen', () => {
    serve({ added: new Set() });
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(), platform: null }} />);
    expect(screen.getByRole('heading', { name: 'Article', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Platforms', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Previews', level: 2 })).toBeTruthy();
    expect(screen.getByText('0 platforms selected')).toBeTruthy();
    expect((screen.getByRole('button', { name: /review and approve/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('link', { name: /review and approve/i })).toBeNull();
    expect(screen.getByText(/Choose a platform to see its preview/)).toBeTruthy();
  });

  it('adds a preview the moment a platform is ticked, sends nothing to any platform, and remembers the choice', async () => {
    const calls = serve({ added: new Set() });
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(), platform: null }} />);
    fireEvent.click(screen.getByLabelText(/^DEV\.to/));
    await waitFor(() => expect(screen.getByText('1 platform selected')).toBeTruthy());
    // The preview of this article on that platform is labelled as approximate, and shows the adapted title.
    await waitFor(() => expect(screen.getByText('Approximate preview')).toBeTruthy());
    expect(screen.getAllByText(/Why the write path stalls \(devto\)/).length).toBeGreaterThan(0);
    // Adding and preparing are the only writes: no stage, approval or publish call exists on this screen.
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url.replace(/[0-9a-f-]{36}/, ':id')}`);
    expect(writes).toEqual(['POST /api/articles/:id/destinations', 'POST /api/platform-drafts']);
    expect(calls.some((c) => /stage|approve|request-approval|publish/.test(c.url))).toBe(false);
    expect(loadRemembered(window.localStorage)).toContain('devto');
    // The way on is open now, and it leads to the one-at-a-time approval queue.
    const review = await screen.findByRole('link', { name: /review and approve/i });
    expect(review.getAttribute('href')).toBe(`/articles/${A1}/publish?view=guided&step=3`);
  });

  it('chooses every recommended platform in one click, one after another, still sending nothing', async () => {
    const calls = serve({ added: new Set() });
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(), platform: null }} />);
    const group = screen.getByRole('region', { name: /recommended for this article/i });
    const names = within(group).getAllByRole('button', { pressed: false }).map((b) => b.textContent);
    fireEvent.click(within(group).getByRole('button', { name: /^Choose all/ }));
    await waitFor(() => expect(screen.getByText(`${names.length} platforms selected`)).toBeTruthy(), { timeout: 4000 });
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => c.method + ' ' + c.url.replace(/[0-9a-f-]{36}/, ':id'));
    expect(writes.filter((w) => w === 'POST /api/articles/:id/destinations')).toHaveLength(names.length);
    expect(writes.filter((w) => w === 'POST /api/platform-drafts')).toHaveLength(names.length);
    expect(calls.some((c) => /stage|approve|request-approval|publish\b/.test(c.url))).toBe(false);
  });

  it('shows one preview per chosen platform, switches between them, and removes one when unticked', async () => {
    const calls = serve({ added: new Set<PlatformId>(['devto', 'hashnode']) });
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto', 'hashnode']), platform: null }} />);
    expect(screen.getByText('2 platforms selected')).toBeTruthy();
    const tabs = within(screen.getByRole('tablist', { name: 'Previews' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['DEV.to', 'Hashnode']);
    fireEvent.click(tabs[1]!);
    expect(screen.getByRole('heading', { name: 'Hashnode', level: 3 })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Preview layout' })).getByRole('button', { name: /compare/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /^Hashnode/ }));
    await waitFor(() => expect(screen.getByText('1 platform selected')).toBeTruthy());
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/destinations/hashnode'))).toBe(true);
    expect(within(screen.getByRole('tablist', { name: 'Previews' })).getAllByRole('tab')).toHaveLength(1);
  });

  it('a platform that is not built cannot be ticked, so it can never reach the approval queue', async () => {
    const calls = serve({ added: new Set() });
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(), platform: null }} />);
    const ghost = screen.getByRole('checkbox', { name: /^Ghost/ }) as HTMLInputElement;
    expect(ghost.disabled).toBe(true);
    fireEvent.click(ghost);
    expect(calls).toHaveLength(0);
    expect(screen.getByText('0 platforms selected')).toBeTruthy();
  });

  it('changing the article loads its own platforms and previews without leaving the page', async () => {
    const state = { added: new Set<PlatformId>() };
    const calls = serve(state);
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto']), platform: null }} />);
    expect(screen.getByText('1 platform selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /change/i }));
    fireEvent.click(screen.getByLabelText(/A short note on retries/));
    await waitFor(() => expect(screen.getByTestId('selected-article').textContent).toBe('A short note on retries'));
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.url.replace(A2, ':id'))).toEqual(expect.arrayContaining(['/api/articles/:id', '/api/articles/:id/destinations']));
    // The other article's choice is not carried over: this one has nothing chosen yet.
    await waitFor(() => expect(screen.getByText('0 platforms selected')).toBeTruthy());
  });
});

// ---- folding, full view, layouts and the expanded preview ----------------------------------------------------------

function inProvider(prefs: Partial<ViewPrefs> = {}) {
  const writes: ViewPrefs[] = [];
  const layouts: ShellLayout[] = [];
  const wrap = (node: React.ReactNode) => (
    <ViewPrefsProvider initial={{ ...DEFAULT_VIEW_PREFS, ...prefs }} write={(p) => writes.push(p)}>
      <ShellLayoutContext.Provider value={(l) => layouts.push(l)}>{node}</ShellLayoutContext.Provider>
    </ViewPrefsProvider>
  );
  return { writes, layouts, wrap };
}

/** The element that holds the Article and Platforms areas (the left group). */
const leftGroup = () => screen.getByRole('heading', { name: 'Article', level: 2 }).closest('section')!.parentElement!;

describe('folding the areas and the full view', () => {
  it('folds an area to a bar that says what it holds, keeps it mounted, and opens it again on click', async () => {
    serve({ added: new Set<PlatformId>(['devto']) });
    const { wrap, writes } = inProvider();
    render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto']), platform: null }} />));
    const fold = screen.getByRole('button', { name: 'Fold Platforms' });
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    const bodyId = fold.getAttribute('aria-controls')!;
    expect(document.getElementById(bodyId)!.hidden).toBe(false);
    fireEvent.click(fold);
    expect(writes.at(-1)!.collapsedAreas).toEqual(['platforms']);
    // The folded bar is one button: its name holds the title and the one-line summary, and it controls the (still mounted) body.
    const bar = screen.getByRole('button', { name: /Platforms.*1 platform selected/ });
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    expect(bar.getAttribute('aria-controls')).toBe(bodyId);
    expect(document.getElementById(bodyId)!.hidden).toBe(true);
    expect(document.getElementById(bodyId)!.querySelectorAll('input[type=checkbox]').length).toBeGreaterThan(0);
    fireEvent.click(bar);
    expect(writes.at(-1)!.collapsedAreas).toEqual([]);
    expect(document.getElementById(bodyId)!.hidden).toBe(false);
  });

  it('shows the chosen article title when the Article area is folded, and starts folded from the saved choice', () => {
    serve({ added: new Set() });
    const { wrap } = inProvider({ collapsedAreas: ['article', 'previews'] });
    render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(), platform: null }} />));
    expect(screen.getByRole('button', { name: /Article.*Why the write path stalls/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: /Previews/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'Fold Platforms' })).toBeTruthy();
  });

  it('full view hides the sidebar and the Article and Platforms areas, keeps the previews live, and Esc or the button brings everything back', async () => {
    serve({ added: new Set<PlatformId>(['devto', 'hashnode']) });
    const { wrap, layouts } = inProvider();
    render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto', 'hashnode']), platform: null }} />));
    expect(leftGroup().className).not.toMatch(/\bhidden\b/);
    const button = screen.getByRole('button', { name: 'Full view' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(leftGroup().className).toMatch(/\bhidden\b/);
    expect(layouts.at(-1)).toMatchObject({ hideSidebar: true, wide: true });
    // The previews and the selection are still there and live.
    expect(within(screen.getByRole('tablist', { name: 'Previews' })).getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByText('2 platforms selected')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(leftGroup().className).not.toMatch(/\bhidden\b/);
    expect(layouts.at(-1)).toEqual(NORMAL_LAYOUT);
    // The same button also leaves it.
    fireEvent.click(button);
    expect(leftGroup().className).toMatch(/\bhidden\b/);
    fireEvent.click(button);
    expect(leftGroup().className).not.toMatch(/\bhidden\b/);
  });

  it('Esc does not leave full view while a dialog is open over it', () => {
    serve({ added: new Set<PlatformId>(['devto']) });
    const { wrap } = inProvider();
    render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto']), platform: null }} />));
    fireEvent.click(screen.getByRole('button', { name: 'Full view' }));
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Full view' }).getAttribute('aria-pressed')).toBe('true');
    dialog.remove();
  });
});

describe('preview layouts and sizes', () => {
  it('switches between one large preview, two or three columns and compare, and remembers the choice', () => {
    serve({ added: new Set<PlatformId>(['devto', 'hashnode']) });
    const { wrap, writes } = inProvider();
    render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto', 'hashnode']), platform: null }} />));
    const layout = within(screen.getByRole('group', { name: 'Preview layout' }));
    expect(layout.getByRole('button', { name: /One large/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByRole('region', { name: /preview$/ })).toHaveLength(1);
    fireEvent.click(layout.getByRole('button', { name: '2 columns' }));
    expect(writes.at(-1)!.previewLayout).toBe('grid2');
    // A grid shows every chosen platform at once and has no tabs.
    expect(screen.getAllByRole('region', { name: /preview$/ })).toHaveLength(2);
    expect(screen.queryByRole('tablist', { name: 'Previews' })).toBeNull();
    fireEvent.click(layout.getByRole('button', { name: /Compare/ }));
    expect(writes.at(-1)!.previewLayout).toBe('compare');
    expect(screen.getByText('What differs')).toBeTruthy();
  });

  it('cannot compare with fewer than two prepared previews', () => {
    serve({ added: new Set<PlatformId>(['devto']) });
    const { wrap } = inProvider({ previewLayout: 'compare' });
    render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto']), platform: null }} />));
    const compare = within(screen.getByRole('group', { name: 'Preview layout' })).getByRole('button', { name: /Compare/ }) as HTMLButtonElement;
    expect(compare.disabled).toBe(true);
    // The saved choice is compare, but with one preview the page shows the single view.
    expect(screen.getByRole('tablist', { name: 'Previews' })).toBeTruthy();
  });

  it('the size control scales the preview surface and is remembered', () => {
    serve({ added: new Set<PlatformId>(['devto']) });
    const { wrap, writes } = inProvider();
    const { container } = render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto']), platform: null }} />));
    const sim = () => container.querySelector('.sim') as HTMLElement;
    expect(sim().style.zoom).toBe('');
    fireEvent.click(within(screen.getByRole('group', { name: 'Preview size' })).getByRole('button', { name: 'Large' }));
    expect(writes.at(-1)!.previewSize).toBe('large');
    expect(sim().style.zoom).toBe('1.25');
    fireEvent.click(within(screen.getByRole('group', { name: 'Preview size' })).getByRole('button', { name: 'Compact' }));
    expect(sim().style.zoom).toBe('0.85');
  });
});

describe('expanding a preview', () => {
  const entries: ExpandEntry[] = (['devto', 'hashnode', 'site'] as PlatformId[]).map((platform) => {
    const d = draft(platform);
    return { platform, name: PLATFORMS[platform].name, lint: [{ code: 'x', severity: 'warning', message: 'A heads up for this platform.' }] as ExpandEntry['lint'], input: { platform, payload: d.payload, extras: d.extras, account: null } };
  });
  const names = entries.map((e) => e.name);

  it('is a labelled dialog with the larger preview, the checks and the device toggle, and Esc closes it', () => {
    const onChange = vi.fn();
    render(<ExpandedPreview entries={entries} current="devto" onChange={onChange} />);
    const dialog = screen.getByRole('dialog', { name: `${names[0]} preview` });
    expect(within(dialog).getByText('A heads up for this platform.')).toBeTruthy();
    expect(within(dialog).getByRole('group', { name: 'Device' })).toBeTruthy();
    expect(within(dialog).getByText(/Preview 1 of 3/)).toBeTruthy();
    // No Expand control inside the overlay itself.
    expect(within(dialog).queryByRole('button', { name: /^Expand/ })).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('moves to the next and previous platform, and comes round at either end', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ExpandedPreview entries={entries} current="site" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: `Next platform: ${names[0]}` }));
    expect(onChange).toHaveBeenLastCalledWith('devto');
    rerender(<ExpandedPreview entries={entries} current="devto" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: `Previous platform: ${names[2]}` }));
    expect(onChange).toHaveBeenLastCalledWith('site');
    // The arrow keys do the same, and wrap too.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('site');
    rerender(<ExpandedPreview entries={entries} current="site" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('devto');
  });

  it('offers no arrows for a single platform, and stays closed when nothing is chosen', () => {
    const { rerender } = render(<ExpandedPreview entries={entries.slice(0, 1)} current="devto" onChange={() => undefined} />);
    expect(screen.queryByRole('button', { name: /^Next platform/ })).toBeNull();
    rerender(<ExpandedPreview entries={entries} current={null} onChange={() => undefined} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('every preview on the publishing screen has an Expand control that opens it', async () => {
    serve({ added: new Set<PlatformId>(['devto', 'hashnode']) });
    const { wrap } = inProvider();
    render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto', 'hashnode']), platform: null }} />));
    const expand = screen.getByRole('button', { name: /^Expand .* preview$/ });
    expect(expand.getAttribute('aria-haspopup')).toBe('dialog');
    await act(async () => {
      fireEvent.click(expand);
    });
    expect(screen.getByRole('dialog', { name: /preview$/ })).toBeTruthy();
  });
});

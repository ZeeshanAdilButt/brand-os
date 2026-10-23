// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArticlePicker } from '../src/components/publish/workspace/article-picker';
import { PlatformSelector } from '../src/components/publish/workspace/platform-selector';
import { ExpandedPreview, type ExpandEntry } from '../src/components/publish/workspace/preview-expand';
import { PublishWorkspace } from '../src/components/publish/workspace/workspace';
import { ViewPrefsProvider } from '../src/components/shell/view-prefs';
import { ShellLayoutContext, type ShellLayout } from '../src/components/shell/shell-layout';
import { DEFAULT_VIEW_PREFS, type ViewPrefs } from '../src/lib/view-prefs';
import { DIRECTORY } from '../src/lib/directory';
import { PLATFORM_IDS, PLATFORMS, RECOMMENDED_ORDER, type DestinationDTO, type PlatformDraftDTO, type PlatformId } from '../src/lib/publishing';
import { areaCounts, filterArticles, journeySteps, monogramOf, pickInitialArticle, rowState, rowsInArea, selectorRows, sortArticles, startArea, wordsFromChars, type ArticleOption } from '../src/lib/publish-workspace';
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

  it('says where the person is in the four steps, and the first step not done is the current one', () => {
    const states = (i: Parameters<typeof journeySteps>[0]) => journeySteps(i).map((p) => p.state);
    expect(states({ selected: 0, prepared: 0, decided: 0, published: 0 })).toEqual(['done', 'current', 'todo', 'todo']);
    expect(states({ selected: 2, prepared: 1, decided: 0, published: 0 })).toEqual(['done', 'current', 'todo', 'todo']);
    expect(states({ selected: 2, prepared: 2, decided: 0, published: 0 })).toEqual(['done', 'done', 'current', 'todo']);
    expect(states({ selected: 2, prepared: 2, decided: 1, published: 0 })).toEqual(['done', 'done', 'current', 'todo']);
    expect(states({ selected: 2, prepared: 2, decided: 2, published: 1 })).toEqual(['done', 'done', 'done', 'current']);
    expect(states({ selected: 2, prepared: 2, decided: 2, published: 2 })).toEqual(['done', 'done', 'done', 'done']);
    expect(journeySteps({ selected: 0, prepared: 0, decided: 0, published: 0 }).map((p) => p.label)).toEqual(['Post chosen', 'Pick platforms', 'Approve each', 'Share the links']);
  });

  it('gives each platform a short tile mark, counts every category and opens on the category of the first suggestion', () => {
    expect(monogramOf('Personal site')).toBe('PS');
    expect(monogramOf('DEV.to')).toBe('DEV');
    expect(monogramOf('Hacker News')).toBe('HN');
    expect(monogramOf('Medium')).toBe('Me');
    expect(monogramOf('X')).toBe('X');
    const rows = selectorRows(new Set());
    const counts = areaCounts(rows);
    expect(Object.values(counts).reduce((x, y) => x + y, 0)).toBe(DIRECTORY.length);
    expect(startArea(rows, ['linkedin', 'devto'])).toBe('social');
    expect(startArea(rows, [])).toBe('blogs');
    expect(rowState(rows.find((r) => r.composer === 'devto')!).attention).toBe(true);
    expect(rowState(rows.find((r) => r.entry.id === 'ghost')!)).toEqual({ label: 'Planned', attention: false });
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
    // One category shows at a time; going through every tab lists every platform exactly once.
    const boxes: HTMLInputElement[] = [];
    for (const tab of screen.getAllByRole('tab')) {
      fireEvent.click(tab);
      boxes.push(...(screen.queryAllByRole('checkbox') as HTMLInputElement[]));
    }
    expect(boxes).toHaveLength(DIRECTORY.length);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toHaveLength(8);
    const disabled = boxes.filter((b) => b.disabled);
    expect(disabled).toHaveLength(DIRECTORY.length - PLATFORM_IDS.length);
    for (const box of disabled) fireEvent.click(box);
    expect(onToggle).not.toHaveBeenCalled();
    // Every blocked entry says why, in its own row (the rows on screen are the last category's).
    for (const row of rows.filter((r) => r.composer === null && r.entry.area === 'aggregators')) expect(screen.getByLabelText(row.entry.name).getAttribute('aria-describedby')).toBeTruthy();
  });

  it('chooses a platform that can be previewed, on click', () => {
    const onToggle = vi.fn();
    render(<PlatformSelector rows={rows} selected={none} busy={none} onToggle={onToggle} recommendations={[]} />);
    fireEvent.click(screen.getByLabelText(/^DEV\.to/));
    expect(onToggle).toHaveBeenCalledWith('devto');
  });

  it('gives each row one real fact from the catalog and one word of state, and a Connect link where a key is missing', () => {
    render(<PlatformSelector rows={rows} selected={none} busy={none} onToggle={() => undefined} recommendations={[]} />);
    // The same sentence is no longer repeated on every row.
    expect(screen.queryByText('Preview and publish from Brand OS')).toBeNull();
    expect(screen.queryByText('Preview here, post by hand')).toBeNull();
    expect(screen.getAllByText('Markdown · canonical link').length).toBeGreaterThan(1);
    expect(screen.getByText('Needs key')).toBeTruthy();
    expect(screen.getByText('Set up')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Connect DEV.to', hidden: true }).getAttribute('href')).toBe('/platforms/integrations#devto');
  });

  it('pins what is chosen at the top, whatever category is open', () => {
    render(<PlatformSelector rows={rows} selected={new Set<PlatformId>(['linkedin'])} busy={none} onToggle={() => undefined} recommendations={[]} />);
    expect(screen.getByText('Chosen')).toBeTruthy();
    const first = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    expect(first.checked).toBe(true);
    expect(first).toBe(screen.getByLabelText(/^LinkedIn/));
    // It is listed once, even when its own category is the open one.
    fireEvent.click(screen.getByRole('tab', { name: /^Social/ }));
    expect(screen.getAllByLabelText(/^LinkedIn/)).toHaveLength(1);
  });

  it('has a category select for a phone beside the filter, and wrapping tabs rather than a scroll strip', () => {
    render(<PlatformSelector rows={rows} selected={none} busy={none} onToggle={() => undefined} recommendations={[]} />);
    const select = screen.getByRole('combobox', { name: 'Category' }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'video' } });
    expect(screen.getByLabelText(/YouTube/)).toBeTruthy();
    expect(screen.getByRole('tablist', { name: 'Categories' }).className).toMatch(/flex-wrap/);
  });

  it('filters by category tab and by search', () => {
    render(<PlatformSelector rows={rows} selected={none} busy={none} onToggle={() => undefined} recommendations={[]} />);
    // It opens on one category, with a count on every tab.
    expect(screen.getByRole('tab', { name: /^Blogs/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByLabelText(/YouTube/)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /^Video/ }));
    expect(screen.getByLabelText(/YouTube/)).toBeTruthy();
    expect(screen.queryByLabelText(/^DEV\.to/)).toBeNull();
    // Searching looks in every category.
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
    expect(screen.getByRole('heading', { name: 'Why the write path stalls', level: 1 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change article' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Where should it go?', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'How it will look', level: 2 })).toBeTruthy();
    expect(screen.getByText('0 selected')).toBeTruthy();
    expect((screen.getByRole('button', { name: /choose a platform/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('link', { name: /^review/i })).toBeNull();
    expect(screen.getByText(/Choose a platform to see its preview/)).toBeTruthy();
  });

  it('adds a preview the moment a platform is ticked, sends nothing to any platform, and remembers the choice', async () => {
    const calls = serve({ added: new Set() });
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(), platform: null }} />);
    fireEvent.click(screen.getByLabelText(/^DEV\.to/));
    await waitFor(() => expect(screen.getByText('1 selected')).toBeTruthy());
    // The preview of this article on that platform is labelled as approximate, and shows the adapted title.
    await waitFor(() => expect(screen.getByText('Approximate preview')).toBeTruthy());
    expect(screen.getAllByText(/Why the write path stalls \(devto\)/).length).toBeGreaterThan(0);
    // Adding and preparing are the only writes: no stage, approval or publish call exists on this screen.
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url.replace(/[0-9a-f-]{36}/, ':id')}`);
    expect(writes).toEqual(['POST /api/articles/:id/destinations', 'POST /api/platform-drafts']);
    expect(calls.some((c) => /stage|approve|request-approval|publish/.test(c.url))).toBe(false);
    expect(loadRemembered(window.localStorage)).toContain('devto');
    // The way on is open now, and it leads to the one-at-a-time approval queue.
    const review = await screen.findByRole('link', { name: /review 1 post/i });
    expect(review.getAttribute('href')).toBe(`/articles/${A1}/publish?view=guided&step=3`);
  });

  it('chooses every recommended platform in one click, one after another, still sending nothing', async () => {
    const calls = serve({ added: new Set() });
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(), platform: null }} />);
    const group = screen.getByRole('region', { name: /recommended for this article/i });
    const names = within(group).getAllByRole('button', { pressed: false }).map((b) => b.textContent);
    fireEvent.click(within(group).getByRole('button', { name: /^Choose all/ }));
    await waitFor(() => expect(screen.getByText(`${names.length} selected`)).toBeTruthy(), { timeout: 4000 });
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => c.method + ' ' + c.url.replace(/[0-9a-f-]{36}/, ':id'));
    expect(writes.filter((w) => w === 'POST /api/articles/:id/destinations')).toHaveLength(names.length);
    expect(writes.filter((w) => w === 'POST /api/platform-drafts')).toHaveLength(names.length);
    expect(calls.some((c) => /stage|approve|request-approval|publish\b/.test(c.url))).toBe(false);
  });

  it('shows one preview per chosen platform, switches between them, and removes one when unticked', async () => {
    const calls = serve({ added: new Set<PlatformId>(['devto', 'hashnode']) });
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto', 'hashnode']), platform: null }} />);
    expect(screen.getByText('2 selected')).toBeTruthy();
    const tabs = within(screen.getByRole('tablist', { name: 'Previews' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['DEV.to', 'Hashnode']);
    fireEvent.click(tabs[1]!);
    expect(screen.getByRole('heading', { name: 'Hashnode', level: 3 })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /^Hashnode/ }));
    await waitFor(() => expect(screen.getByText('1 selected')).toBeTruthy());
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
    expect(screen.getByText('0 selected')).toBeTruthy();
  });

  it('changing the article loads its own platforms and previews without leaving the page', async () => {
    const state = { added: new Set<PlatformId>() };
    const calls = serve(state);
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto']), platform: null }} />);
    expect(screen.getByText('1 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /change/i }));
    fireEvent.click(screen.getByLabelText(/A short note on retries/));
    await waitFor(() => expect(screen.getByTestId('selected-article').textContent).toBe('A short note on retries'));
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.url.replace(A2, ':id'))).toEqual(expect.arrayContaining(['/api/articles/:id', '/api/articles/:id/destinations']));
    // The other article's choice is not carried over: this one has nothing chosen yet.
    await waitFor(() => expect(screen.getByText('0 selected')).toBeTruthy());
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

/** The element that holds the Platforms area (the left column). */
const leftGroup = () => screen.getByRole('heading', { name: 'Where should it go?', level: 2 }).closest('section')!.parentElement!;

/** Opens the View panel of the first preview on the page and returns it. */
async function openView() {
  fireEvent.click(screen.getAllByRole('button', { name: /View options/ })[0]!);
  return within(await screen.findByRole('dialog'));
}

const closeView = async () => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
};

describe('hiding the platform list and the full view', () => {
  it('hides the platform list from the View panel to a bar that says what it holds, keeps it mounted, and opens it again on click', async () => {
    serve({ added: new Set<PlatformId>(['devto']) });
    const { wrap, writes } = inProvider();
    render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto']), platform: null }} />));
    // There is no fold button on the page itself: the one place for it is the View panel.
    expect(screen.queryByRole('button', { name: 'Fold Platforms' })).toBeNull();
    const view = await openView();
    fireEvent.click(view.getByRole('button', { name: 'Hide platform list' }));
    expect(writes.at(-1)!.collapsedAreas).toEqual(['platforms']);
    // The folded bar is one button: its name holds the title and the one-line summary, and it controls the (still mounted) body.
    const bar = screen.getByRole('button', { name: /Platforms.*1 platform selected/ });
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    const bodyId = bar.getAttribute('aria-controls')!;
    expect(document.getElementById(bodyId)!.hidden).toBe(true);
    expect(document.getElementById(bodyId)!.querySelectorAll('input[type=checkbox]').length).toBeGreaterThan(0);
    fireEvent.click(bar);
    expect(writes.at(-1)!.collapsedAreas).toEqual([]);
    expect(document.getElementById(bodyId)!.hidden).toBe(false);
  });

  it('starts folded from the saved choice and still shows the article and the previews', () => {
    serve({ added: new Set() });
    const { wrap } = inProvider({ collapsedAreas: ['platforms'] });
    render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(), platform: null }} />));
    expect(screen.getByRole('button', { name: /Platforms.*0 platforms selected/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('heading', { name: 'Why the write path stalls', level: 1 })).toBeTruthy();
    expect(screen.getByText(/Choose a platform to see its preview/)).toBeTruthy();
  });

  it('full view hides the sidebar and the platform list, keeps the previews live, and Esc or a button brings everything back', async () => {
    serve({ added: new Set<PlatformId>(['devto', 'hashnode']) });
    const { wrap, layouts } = inProvider();
    render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto', 'hashnode']), platform: null }} />));
    expect(leftGroup().className).not.toMatch(/\bhidden\b/);
    expect(screen.queryByRole('button', { name: 'Leave full view' })).toBeNull();
    const view = await openView();
    const button = view.getByRole('button', { name: 'Full view' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(leftGroup().className).toMatch(/\bhidden\b/);
    expect(layouts.at(-1)).toMatchObject({ hideSidebar: true, wide: true });
    // The previews and the selection are still there and live.
    expect(within(screen.getByRole('tablist', { name: 'Previews' })).getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Leave full view' })).toBeTruthy();
    // The first Escape closes the View panel, the next one leaves full view.
    await closeView();
    expect(leftGroup().className).toMatch(/\bhidden\b/);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(leftGroup().className).not.toMatch(/\bhidden\b/);
    // Back to the page's own layout: the sidebar is shown and the page is not full width.
    expect(layouts.at(-1)).toMatchObject({ hideSidebar: false, hideHeader: false, wide: false });
    expect(screen.queryByRole('button', { name: 'Leave full view' })).toBeNull();
    // The visible button leaves it too.
    const again = await openView();
    fireEvent.click(again.getByRole('button', { name: 'Full view' }));
    expect(leftGroup().className).toMatch(/\bhidden\b/);
    fireEvent.click(screen.getByRole('button', { name: 'Leave full view' }));
    expect(leftGroup().className).not.toMatch(/\bhidden\b/);
  });

  it('Esc does not leave full view while a dialog is open over it', async () => {
    serve({ added: new Set<PlatformId>(['devto']) });
    const { wrap } = inProvider();
    render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto']), platform: null }} />));
    const view = await openView();
    fireEvent.click(view.getByRole('button', { name: 'Full view' }));
    await closeView();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Leave full view' })).toBeTruthy();
    dialog.remove();
  });

  it('on a phone one list shows at a time, chosen by a switch at the top', () => {
    serve({ added: new Set<PlatformId>(['devto']) });
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto']), platform: null }} />);
    const preview = () => screen.getByRole('heading', { name: 'How it will look', level: 2 }).closest('section')!;
    const show = within(screen.getByRole('group', { name: 'Show' }));
    expect(show.getByRole('button', { name: 'Platforms (1)' }).getAttribute('aria-pressed')).toBe('true');
    expect(preview().className).toMatch(/max-lg:hidden/);
    expect(leftGroup().className).not.toMatch(/max-lg:hidden/);
    fireEvent.click(show.getByRole('button', { name: 'Preview' }));
    expect(preview().className).not.toMatch(/max-lg:hidden/);
    expect(leftGroup().className).toMatch(/max-lg:hidden/);
  });
});

describe('the View panel', () => {
  it('switches between one large preview, two or three columns and compare, and remembers the choice', async () => {
    serve({ added: new Set<PlatformId>(['devto', 'hashnode']) });
    const { wrap, writes } = inProvider();
    render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto', 'hashnode']), platform: null }} />));
    // Nothing about layout is on the page until the panel is opened.
    expect(screen.queryByRole('group', { name: 'Preview layout' })).toBeNull();
    const layout = within((await openView()).getByRole('group', { name: 'Preview layout' }));
    expect(layout.getByRole('button', { name: /Single/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByRole('region', { name: /preview$/ })).toHaveLength(1);
    fireEvent.click(layout.getByRole('button', { name: '2 col' }));
    expect(writes.at(-1)!.previewLayout).toBe('grid2');
    // A grid shows every chosen platform at once and has no tabs.
    expect(screen.getAllByRole('region', { name: /preview$/ })).toHaveLength(2);
    expect(screen.queryByRole('tablist', { name: 'Previews' })).toBeNull();
    const again = within((await openView()).getByRole('group', { name: 'Preview layout' }));
    fireEvent.click(again.getByRole('button', { name: /Compare/ }));
    expect(writes.at(-1)!.previewLayout).toBe('compare');
    expect(screen.getByText('What differs')).toBeTruthy();
  });

  it('cannot compare with fewer than two prepared previews', async () => {
    serve({ added: new Set<PlatformId>(['devto']) });
    const { wrap } = inProvider({ previewLayout: 'compare' });
    render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto']), platform: null }} />));
    const compare = within((await openView()).getByRole('group', { name: 'Preview layout' })).getByRole('button', { name: /Compare/ }) as HTMLButtonElement;
    expect(compare.disabled).toBe(true);
    // The saved choice is compare, but with one preview the page shows the single view.
    expect(screen.getByRole('tablist', { name: 'Previews' })).toBeTruthy();
  });

  it('the size control scales the preview surface and is remembered', async () => {
    serve({ added: new Set<PlatformId>(['devto']) });
    const { wrap, writes } = inProvider();
    const { container } = render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto']), platform: null }} />));
    const sim = () => container.querySelector('.sim') as HTMLElement;
    expect(sim().style.zoom).toBe('');
    const view = await openView();
    fireEvent.click(within(view.getByRole('group', { name: 'Preview size' })).getByRole('button', { name: 'Large' }));
    expect(writes.at(-1)!.previewSize).toBe('large');
    expect(sim().style.zoom).toBe('1.25');
    fireEvent.click(within(view.getByRole('group', { name: 'Preview size' })).getByRole('button', { name: 'Compact' }));
    expect(sim().style.zoom).toBe('0.85');
  });

  it('device and appearance are chosen once for every preview, and remembered', async () => {
    serve({ added: new Set<PlatformId>(['devto', 'hashnode']) });
    const { wrap, writes } = inProvider();
    const { container } = render(wrap(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto', 'hashnode']), platform: null }} />));
    const sim = () => container.querySelector('.sim') as HTMLElement;
    expect(sim().getAttribute('data-device')).toBe('desktop');
    expect(sim().getAttribute('data-appearance')).toBe('light');
    const view = await openView();
    fireEvent.click(view.getByRole('button', { name: 'Mobile' }));
    fireEvent.click(view.getByRole('button', { name: 'Dark' }));
    expect(writes.at(-1)).toMatchObject({ previewDevice: 'mobile', previewAppearance: 'dark' });
    expect(sim().getAttribute('data-device')).toBe('mobile');
    expect(sim().getAttribute('data-appearance')).toBe('dark');
    await closeView();
    // The choice follows the person to the next platform instead of resetting.
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Previews' })).getAllByRole('tab')[1]!);
    expect(sim().getAttribute('data-device')).toBe('mobile');
  });

  it('keeps the placeholder note and the Float, Full view and platform list choices in the same panel', async () => {
    serve({ added: new Set<PlatformId>(['devto']) });
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto']), platform: null }} />);
    const view = await openView();
    expect(view.getByRole('button', { name: 'Float window' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Full view' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Hide platform list' })).toBeTruthy();
    expect(view.getByText(/placeholders and inert/)).toBeTruthy();
  });
});

describe('the checks pill', () => {
  const withIssues = () =>
    ALL(['devto']).map((d) =>
      d.platform === 'devto'
        ? { ...d, draft: { ...d.draft!, lint: [{ code: 'canonical', severity: 'error', message: 'Add a canonical link.' }, { code: 'tags', severity: 'warning', message: 'These tags are long.' }] as PlatformDraftDTO['lint'] } }
        : d,
    );

  it('says what is wrong in one short pill and opens the full list in place, closed to start with', () => {
    serve({ added: new Set<PlatformId>(['devto']) });
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: withIssues(), platform: null }} />);
    const pill = screen.getByRole('button', { name: /1 to fix · 1 heads up/ });
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('See checks')).toBeNull();
    const list = screen.getByText('Add a canonical link.').closest('[hidden]');
    expect(list).toBeTruthy();
    fireEvent.click(pill);
    expect(pill.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Add a canonical link.').closest('[hidden]')).toBeNull();
    expect(pill.getAttribute('aria-controls')).toBe(list!.id);
  });

  it('is a quiet note, not a control, when nothing needs a look', () => {
    serve({ added: new Set<PlatformId>(['devto']) });
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto']), platform: null }} />);
    expect(screen.getByText('Checks passed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /heads up|to fix/ })).toBeNull();
  });
});

describe('what is left out of the page', () => {
  it('has no row of open-preview chips in the footer: the tabs already switch previews', () => {
    serve({ added: new Set<PlatformId>(['devto', 'hashnode']) });
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto', 'hashnode']), platform: null }} />);
    expect(screen.queryByRole('list', { name: 'Open a preview large' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Expand .* preview$/ })).toHaveLength(1);
  });

  it('shows the suggestions only to someone with nothing chosen and nothing connected', () => {
    serve({ added: new Set<PlatformId>() });
    const first = render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(), platform: null }} />);
    expect(screen.getByRole('region', { name: /recommended for this article/i })).toBeTruthy();
    first.unmount();
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto']), platform: null }} />);
    expect(screen.queryByRole('region', { name: /recommended for this article/i })).toBeNull();
  });

  it('names the number of posts on the one primary button', () => {
    serve({ added: new Set<PlatformId>(['devto', 'hashnode']) });
    render(<PublishWorkspace articles={ARTICLES} initial={{ article: article(), destinations: ALL(['devto', 'hashnode']), platform: null }} />);
    expect(screen.getByRole('link', { name: /Review 2 posts/ }).getAttribute('href')).toBe('/articles/' + A1 + '/publish?view=guided&step=3');
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

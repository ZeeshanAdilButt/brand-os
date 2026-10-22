// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArticlePicker } from '../src/components/publish/workspace/article-picker';
import { PlatformSelector } from '../src/components/publish/workspace/platform-selector';
import { PublishWorkspace } from '../src/components/publish/workspace/workspace';
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
    expect(screen.getByRole('button', { name: /compare side by side/i })).toBeTruthy();
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

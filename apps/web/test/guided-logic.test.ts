import { describe, expect, it } from 'vitest';
import { draftChip, directoryChip, TONE_CLASS } from '../src/lib/chips';
import { PLATFORM_IDS, type PlatformId } from '../src/lib/catalog';
import { buildCommands, filterCommands, FORBIDDEN_LABEL } from '../src/lib/commands';
import { computeJourney, type JourneyDestination, type JourneyInput } from '../src/lib/next-step';
import { approveCurrent, beginPublishing, currentOf, isFinished, resume, settle, skipCurrent, startQueue, summary } from '../src/lib/publish-queue';
import { articleFacts, recommend } from '../src/lib/recommend';
import { DEFAULT_WIZARD, loadRemembered, loadWizard, parseWizard, saveRemembered, saveWizard, wizardKey } from '../src/lib/wizard-state';

const ID = '4f1b6c1e-9a3d-4e2b-8c55-0d7a1f2e3b4c';

function dest(platform: PlatformId, over: Partial<JourneyDestination> = {}): JourneyDestination {
  const publishable = platform === 'devto' || platform === 'hashnode' || platform === 'site';
  return { platform, name: platform === 'devto' ? 'DEV.to' : platform === 'linkedin' ? 'LinkedIn' : platform === 'site' ? 'Personal site' : platform, added: true, publishable, connected: publishable, draft: null, ...over };
}
const draft = (status: NonNullable<JourneyDestination['draft']>['status'], over: Partial<NonNullable<JourneyDestination['draft']>> = {}) => ({ status, publishedVia: null, lintErrors: 0, ...over });
const input = (over: Partial<JourneyInput> = {}): JourneyInput => ({ articleCount: 1, article: { id: ID, title: 'Write path', hasText: true }, destinations: [], ...over });

describe('the next step is computed from what is really true', () => {
  it('starts with writing or importing when there is no article, and says why', () => {
    const j = computeJourney({ articleCount: 0, article: null, destinations: [] });
    expect(j.next).toMatchObject({ label: 'Write or import an article', href: '/articles/import' });
    expect(j.steps.map((s) => s.state)).toEqual(['current', 'todo', 'todo', 'todo', 'todo']);
    expect(j.steps.map((s) => s.label)).toEqual(['Write or import an article', 'Pick destinations', 'Preview each one', 'Approve', 'Share the link']);
    expect(j.allDone).toBe(false);
  });

  it('asks for text when the article is empty, and for destinations when it has text', () => {
    expect(computeJourney(input({ article: { id: ID, title: 'Empty', hasText: false } })).next).toMatchObject({ label: expect.stringContaining('Add text'), href: `/articles/${ID}` });
    const picked = computeJourney(input());
    expect(picked.next).toMatchObject({ label: 'Pick destinations', href: `/publishing?article=${ID}` });
    expect(picked.steps.map((s) => s.state)).toEqual(['done', 'current', 'todo', 'todo', 'todo']);
  });

  it('previews every destination before the first approval, one at a time', () => {
    const j = computeJourney(input({ destinations: [dest('site', { draft: draft('draft') }), dest('devto'), dest('linkedin')] }));
    expect(j.next).toMatchObject({ label: 'Preview DEV.to', href: `/publishing?article=${ID}&platform=devto` });
    expect(j.steps.find((s) => s.id === 'preview')?.state).toBe('current');
    expect(j.steps.find((s) => s.id === 'preview')?.detail).toBe('1 of 3 prepared.');
  });

  it('ignores destinations that were not added', () => {
    const j = computeJourney(input({ destinations: [dest('site', { added: false }), dest('devto', { added: false })] }));
    expect(j.next.label).toBe('Pick destinations');
  });

  it.each([
    ['a blocking problem', dest('devto', { draft: draft('draft', { lintErrors: 2 }) }), 'Fix 2 problems in DEV.to', 'platform=devto'],
    ['one problem', dest('devto', { draft: draft('draft', { lintErrors: 1 }) }), 'Fix 1 problem in DEV.to', 'platform=devto'],
    ['a connector that needs an account', dest('devto', { connected: false, draft: draft('draft') }), 'Connect DEV.to', '/platforms/integrations#devto'],
    ['a draft ready to review', dest('devto', { draft: draft('staged') }), 'Review and approve DEV.to', 'step=3'],
    ['a waiting approval', dest('devto', { draft: draft('pending_approval') }), 'Review and approve DEV.to', 'step=3'],
    ['a refused publish', dest('devto', { draft: draft('failed') }), 'Fix and try DEV.to again', 'step=3'],
    ['an unknown result', dest('devto', { draft: draft('unknown') }), 'Check DEV.to on the platform', 'step=3'],
    ['a changed article', dest('devto', { draft: draft('source_changed') }), 'Rebuild DEV.to from the changed article', 'step=3'],
    ['a platform with no connector', dest('linkedin', { draft: draft('draft') }), 'Post LinkedIn by hand and record the link', 'step=3'],
  ])('with %s the next step is "%s"', (_label, d, label, hrefPart) => {
    const j = computeJourney(input({ destinations: [d] }));
    expect(j.next.label).toBe(label);
    expect(j.next.href).toContain(hrefPart);
    expect(j.next.why.length).toBeGreaterThan(15);
  });

  it('follows the owner’s order and skips what is already out', () => {
    const j = computeJourney(input({ destinations: [dest('site', { draft: draft('published') }), dest('devto', { draft: draft('staged') }), dest('linkedin', { draft: draft('draft') })] }));
    expect(j.next.label).toBe('Review and approve DEV.to');
    expect(j.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'current', 'todo']);
    expect(j.steps.find((s) => s.id === 'approve')?.detail).toBe('1 of 3 published or posted.');
  });

  it('ends at "copy your live links" only when everything added is out, by the app or by hand', () => {
    const out = computeJourney(input({ destinations: [dest('site', { draft: draft('published') }), dest('linkedin', { draft: draft('published', { publishedVia: 'manual' }) })] }));
    expect(out.next).toMatchObject({ label: 'Copy your live links', href: `/articles/${ID}/publish?step=4` });
    expect(out.allDone).toBe(true);
    expect(out.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'current']);
    const partial = computeJourney(input({ destinations: [dest('site', { draft: draft('published') }), dest('devto', { draft: draft('publishing') })] }));
    expect(partial.allDone).toBe(false);
  });

  it('has no stored progress: the same state always gives the same answer', () => {
    const state = input({ destinations: [dest('devto', { draft: draft('staged') })] });
    expect(computeJourney(state)).toEqual(computeJourney(structuredClone(state)));
  });
});

describe('recommended destinations', () => {
  const facts = (over: Partial<ReturnType<typeof articleFacts>> = {}) => ({ words: 900, hasCode: true, hasCanonical: true, hasDescription: true, tags: ['go'], ...over });
  const none = { connected: new Set<PlatformId>(), remembered: [] as PlatformId[] };

  it('counts words outside code and detects code', () => {
    const f = articleFacts({ bodyMarkdown: 'One two three.\n\n```go\nfunc main() {}\n```\n', tags: [], canonicalUrl: null, description: '' });
    expect(f).toMatchObject({ words: 3, hasCode: true, hasCanonical: false, hasDescription: false });
  });

  it('always starts with the personal site, and says why on every chip', () => {
    const out = recommend(facts(), none);
    expect(out[0]).toMatchObject({ platform: 'site' });
    for (const r of out) expect(r.reason.length).toBeGreaterThan(15);
  });

  it('suggests DEV.to for a long technical article and social posts when there is a link to share', () => {
    const platforms = recommend(facts(), none).map((r) => r.platform);
    expect(platforms).toEqual(expect.arrayContaining(['site', 'devto', 'linkedin', 'bluesky']));
  });

  it('does not suggest a link-sharing post without a canonical link, nor DEV.to for a short note', () => {
    const platforms = recommend(facts({ hasCanonical: false, words: 120, hasCode: false }), none).map((r) => r.platform);
    expect(platforms).toEqual(['site']);
  });

  it('is careful with Hacker News: only for a substantial technical piece', () => {
    expect(recommend(facts({ words: 900, hasCode: true }), none).map((r) => r.platform)).toContain('hackernews');
    expect(recommend(facts({ words: 900, hasCode: false }), none).map((r) => r.platform)).not.toContain('hackernews');
    expect(recommend(facts({ words: 400, hasCode: true }), none).map((r) => r.platform)).not.toContain('hackernews');
  });

  it('remembers what the owner chose before, and nudges a connected Hashnode', () => {
    const out = recommend(facts({ hasCanonical: false, words: 500 }), { connected: new Set<PlatformId>(['hashnode']), remembered: ['mastodon'] });
    const byPlatform = Object.fromEntries(out.map((r) => [r.platform, r.reason]));
    expect(byPlatform.mastodon).toMatch(/last time/);
    expect(byPlatform.hashnode).toMatch(/connected/);
  });

  it('returns at most five, in the recommended order, never an unknown id', () => {
    const out = recommend(facts(), { connected: new Set<PlatformId>(['hashnode', 'medium']), remembered: ['x', 'reddit', 'youtube', 'bogus' as PlatformId] });
    expect(out.length).toBeLessThanOrEqual(5);
    for (const r of out) expect(PLATFORM_IDS).toContain(r.platform);
  });
});

describe('the wizard remembers its place', () => {
  const store = () => {
    const map = new Map<string, string>();
    return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
  };

  it('round-trips the step, the chosen destinations and the focus', () => {
    const s = store();
    saveWizard(s, ID, { v: 1, step: 3, selected: ['site', 'devto'], focus: 'devto' });
    expect(s.map.has(wizardKey(ID))).toBe(true);
    expect(loadWizard(s, ID)).toEqual({ v: 1, step: 3, selected: ['site', 'devto'], focus: 'devto' });
    expect(loadWizard(s, 'another-article')).toEqual(DEFAULT_WIZARD);
  });

  it('survives damaged or hostile stored text', () => {
    for (const raw of ['', 'not json', '{"v":2}', 'null', '[]', '{"v":1,"step":99,"selected":"x"}']) {
      const parsed = parseWizard(raw);
      expect(parsed.v).toBe(1);
      expect([1, 2, 3, 4]).toContain(parsed.step);
      expect(Array.isArray(parsed.selected)).toBe(true);
    }
    expect(parseWizard('{"v":1,"step":2,"selected":["devto","evil","devto"],"focus":"x"}')).toEqual({ v: 1, step: 2, selected: ['devto'], focus: null });
  });

  it('works without storage, or with storage that throws', () => {
    expect(loadWizard(null, ID)).toEqual(DEFAULT_WIZARD);
    expect(() => saveWizard(null, ID, DEFAULT_WIZARD)).not.toThrow();
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('denied'); } };
    expect(loadWizard(broken, ID)).toEqual(DEFAULT_WIZARD);
    expect(() => saveWizard(broken, ID, DEFAULT_WIZARD)).not.toThrow();
    expect(loadRemembered(broken)).toEqual([]);
  });

  it('remembers the last chosen destinations across articles', () => {
    const s = store();
    expect(loadRemembered(s)).toEqual([]);
    saveRemembered(s, ['site', 'devto', 'site', 'linkedin']);
    expect(loadRemembered(s)).toEqual(['site', 'devto', 'linkedin']);
  });
});

describe('the review queue approves one destination at a time', () => {
  it('starts with exactly one destination under review, the first', () => {
    const q = startQueue(['site', 'devto', 'linkedin']);
    expect(currentOf(q)).toBe('site');
    expect(approveCurrent(q)).toBe('site');
    expect(q.items).toEqual({ site: 'review', devto: 'waiting', linkedin: 'waiting' });
  });

  it('never has two destinations under review or publishing at once', () => {
    let q = startQueue(['site', 'devto', 'linkedin']);
    const active = () => q.order.filter((p) => q.items[p] === 'review' || q.items[p] === 'publishing').length;
    expect(active()).toBe(1);
    q = beginPublishing(q, 'site');
    expect(active()).toBe(1);
    expect(approveCurrent(q)).toBeNull(); // waiting on the result: a second click approves nothing
    q = settle(q, 'site', 'published');
    expect(active()).toBe(1);
    expect(approveCurrent(q)).toBe('devto');
  });

  it('refuses to begin publishing a destination that is not the current one', () => {
    const q = startQueue(['site', 'devto']);
    expect(beginPublishing(q, 'devto')).toBe(q);
    expect(q.items.devto).toBe('waiting');
  });

  it('runs in the chosen order, with a progress summary, and finishes', () => {
    let q = startQueue(['devto', 'site', 'linkedin']);
    const seen: string[] = [];
    while (approveCurrent(q)) {
      const p = approveCurrent(q)!;
      seen.push(p);
      q = settle(beginPublishing(q, p), p, 'published');
    }
    expect(seen).toEqual(['devto', 'site', 'linkedin']);
    expect(isFinished(q)).toBe(true);
    expect(summary(q)).toEqual({ published: 3, total: 3 });
  });

  it('stops on a failure and says why, leaving the rest waiting and untouched', () => {
    let q = startQueue(['site', 'devto', 'linkedin']);
    q = settle(beginPublishing(q, 'site'), 'site', 'published');
    q = settle(beginPublishing(q, 'devto'), 'devto', 'failed');
    expect(q.stopped).toMatchObject({ platform: 'devto' });
    expect(q.stopped!.reason).toMatch(/other destinations are untouched/);
    expect(q.items).toEqual({ site: 'published', devto: 'failed', linkedin: 'waiting' });
    expect(approveCurrent(q)).toBeNull();
    expect(isFinished(q)).toBe(false);
  });

  it('stops on an unknown result too, and tells the owner to check first', () => {
    let q = startQueue(['devto', 'site']);
    q = settle(beginPublishing(q, 'devto'), 'devto', 'unknown');
    expect(q.stopped?.reason).toMatch(/Check it on the platform/);
    expect(q.items.site).toBe('waiting');
  });

  it('can retry the stopped destination, and skip one without publishing it', () => {
    let q = startQueue(['site', 'devto', 'linkedin']);
    q = settle(beginPublishing(q, 'site'), 'site', 'failed');
    q = resume(q);
    expect(q.stopped).toBeNull();
    expect(approveCurrent(q)).toBe('site');
    q = skipCurrent(q);
    expect(q.items.site).toBe('skipped');
    expect(approveCurrent(q)).toBe('devto');
  });

  it('exposes no way to approve several at once', async () => {
    const mod = await import('../src/lib/publish-queue');
    for (const name of Object.keys(mod)) expect(name, name).not.toMatch(/all|bulk|batch|every/i);
    // The one approval function returns a single platform, never a list.
    expect(Array.isArray(approveCurrent(startQueue(['site', 'devto'])))).toBe(false);
  });
});

describe('the command palette', () => {
  const commands = buildCommands({ articles: [{ id: ID, title: 'Write path' }], currentArticleId: ID });

  it('lists pages and harmless actions, with unique ids', () => {
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length);
    expect(commands.map((c) => c.label)).toEqual(expect.arrayContaining(['Home: your next step', 'Articles', 'New article', 'Write path', 'Set up DEV.to', 'DEV.to: what it can do']));
    expect(commands.filter((c) => c.id.startsWith('platform-'))).toHaveLength(PLATFORM_IDS.length);
  });

  it('never lists a command that approves, declines or publishes', () => {
    for (const c of commands) {
      expect(c.label, c.id).not.toMatch(FORBIDDEN_LABEL);
      expect(`${c.label} ${c.hint ?? ''}`, c.id).not.toMatch(/\b(approve|decline|approval)\b/i);
      expect(c.href ?? '', c.id).not.toMatch(/^\/api\//);
      expect(c.href ?? '', c.id).not.toMatch(/approve|decline|\/stage|request-approval/);
      expect(Boolean(c.href) !== Boolean(c.action), `${c.id} is a link or a local action`).toBe(true);
      if (c.action) expect(['new-article', 'toggle-theme']).toContain(c.action);
    }
    expect(commands.filter((c) => c.href?.includes('/publish') && c.href.includes(ID)).map((c) => c.href)).toEqual([`/publishing?article=${ID}`, `/articles/${ID}/publish?view=composer`]);
  });

  it('finds things by any word in the label, hint or keywords', () => {
    expect(filterCommands(commands, 'dev.to').map((c) => c.id)).toEqual(expect.arrayContaining(['platform-devto', 'setup-devto']));
    expect(filterCommands(commands, 'oauth keys').length).toBeGreaterThan(0);
    expect(filterCommands(commands, 'zzzz')).toEqual([]);
    expect(filterCommands(commands, '')).toHaveLength(commands.length);
  });

  it('offers the sharing steps only when an article is open', () => {
    expect(buildCommands({ articles: [] }).some((c) => c.id === 'article-wizard')).toBe(false);
    expect(commands.some((c) => c.id === 'article-wizard')).toBe(true);
  });
});

describe('one status language', () => {
  const statuses = ['draft', 'staged', 'pending_approval', 'approved', 'publishing', 'published', 'failed', 'unknown', 'source_changed'] as const;

  it('gives every draft status words, a tone and an icon, so colour never carries the meaning alone', () => {
    const labels = new Set<string>();
    for (const status of statuses) {
      const chip = draftChip('devto', { status, publishedVia: null });
      expect(chip.label.length).toBeGreaterThan(2);
      expect(Object.keys(TONE_CLASS)).toContain(chip.tone);
      expect(chip.icon).toBeTruthy();
      labels.add(chip.label);
    }
    expect(labels.size).toBe(statuses.length);
    expect(draftChip('devto', null)).toEqual({ label: 'Not prepared', tone: 'neutral', icon: 'dashed-circle' });
    expect(draftChip('devto', { status: 'source_changed', publishedVia: null }).label).toBe('Stale');
    expect(draftChip('devto', { status: 'staged', publishedVia: null }).label).toBe('Private draft');
    expect(draftChip('linkedin', { status: 'published', publishedVia: 'manual' })).toMatchObject({ label: 'Posted by hand', tone: 'success' });
    expect(draftChip('site', { status: 'published', publishedVia: 'app' }).label).toBe('Pull request opened');
  });

  it('separates attention, progress, success and uncertainty', () => {
    const tone = (status: (typeof statuses)[number]) => draftChip('devto', { status, publishedVia: null });
    expect(tone('pending_approval')).toMatchObject({ tone: 'warning', icon: 'review' }); // needs you
    expect(tone('approved')).toMatchObject({ tone: 'info', icon: 'shield-check' }); // recorded, not proof of publication
    expect(tone('publishing')).toMatchObject({ tone: 'info', icon: 'spinner' }); // in progress
    expect(tone('published')).toMatchObject({ tone: 'success', icon: 'check-circle' });
    expect(tone('failed')).toMatchObject({ tone: 'danger' });
    expect(tone('unknown')).toMatchObject({ tone: 'warning', icon: 'help-circle' }); // uncertain
    // Waiting for you, being published and live must not look alike.
    const looks = ['pending_approval', 'approved', 'publishing', 'published'].map((s) => `${tone(s as (typeof statuses)[number]).tone}/${tone(s as (typeof statuses)[number]).icon}`);
    expect(new Set(looks).size).toBe(4);
  });

  it('shows planned platforms as dashed and disabled with their phase', () => {
    expect(directoryChip('planned', 'Phase 2')).toEqual({ label: 'Planned: Phase 2', tone: 'planned', icon: 'calendar' });
    expect(directoryChip('available_now', null)).toMatchObject({ tone: 'success' });
    expect(directoryChip('needs_connection', null)).toMatchObject({ tone: 'attention' });
    expect(TONE_CLASS.planned).toContain('border-dashed');
  });
});

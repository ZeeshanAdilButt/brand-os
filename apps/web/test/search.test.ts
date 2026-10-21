import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MARK_END, MARK_START, type ItemInput } from '../src/server/data/knowledge';
import { forOwner, type OwnerData } from '../src/server/data/tenant';
import type { DbHandle } from '../src/server/db/client';
import { users } from '../src/server/db/schema';
import { memoryDb } from './helpers';

let handle: DbHandle;
let data: OwnerData;
const OWNER = '11111111-1111-4111-8111-111111111111';

function item(overrides: Partial<ItemInput>): ItemInput {
  return {
    kind: 'note',
    title: 'Untitled',
    body: '',
    tags: [],
    sourceId: null,
    sourceDate: null,
    verificationStatus: 'unverified',
    confidence: 'medium',
    confidentiality: 'private',
    publicUsePermitted: false,
    ...overrides,
  };
}

beforeAll(async () => {
  handle = await memoryDb();
  await handle.db.insert(users).values({ id: OWNER, kind: 'member', displayName: 'Searcher' });
  data = forOwner(OWNER, handle.db);
  await data.items.create(item({ title: 'Connection pooling', body: 'We tuned the pool size under load and watched queue depth.', tags: ['postgres'] }));
  await data.items.create(item({ title: 'Weekly notes', body: 'The pooling change reduced tail latency. Pooling again later.', kind: 'reading' }));
  await data.items.create(item({ title: 'Runbook', body: 'Restart the workers when they are running hot.', tags: ['sre', 'oncall'] }));
  await data.items.create(item({ title: 'Cert', body: 'Passed the exam.', kind: 'certification', confidentiality: 'public' }));
});

afterAll(async () => {
  await handle.close();
});

describe('knowledge search', () => {
  it('ranks a title match above a body-only match', async () => {
    const hits = await data.items.search('pooling');
    expect(hits.map((h) => h.item.title)).toEqual(['Connection pooling', 'Weekly notes']);
    expect(hits[0]!.rank).toBeGreaterThan(hits[1]!.rank);
  });

  it('wraps matches in markers and leaves HTML to the renderer', async () => {
    const [hit] = await data.items.search('latency');
    expect(hit?.snippet).toContain(`${MARK_START}latency${MARK_END}`);
    expect(hit?.snippet).not.toContain('<mark>');
  });

  it('stems words and finds tags', async () => {
    expect((await data.items.search('run')).map((h) => h.item.title)).toContain('Runbook');
    expect((await data.items.search('oncall')).map((h) => h.item.title)).toEqual(['Runbook']);
  });

  it('combines text search with the kind and confidentiality filters', async () => {
    expect((await data.items.search('pooling', { kind: 'reading' })).map((h) => h.item.title)).toEqual(['Weekly notes']);
    expect(await data.items.search('exam', { confidentiality: 'private' })).toEqual([]);
    expect((await data.items.search('exam', { confidentiality: 'public' })).map((h) => h.item.title)).toEqual(['Cert']);
  });

  it('returns nothing for stop words, gibberish and hostile query strings, without error', async () => {
    expect(await data.items.search('the')).toEqual([]);
    expect(await data.items.search("'; drop table knowledge_items; --")).toEqual([]);
    expect(await data.items.search('((( &&& !!!')).toEqual([]);
    expect((await data.items.counts()).total).toBe(4);
  });

  it('supports quoted phrases and exclusion in web search syntax', async () => {
    expect((await data.items.search('"tail latency"')).map((h) => h.item.title)).toEqual(['Weekly notes']);
    expect((await data.items.search('pooling -latency')).map((h) => h.item.title)).toEqual(['Connection pooling']);
  });

  it('keeps the index current when an item is edited or reviewed', async () => {
    const [hit] = await data.items.search('Passed');
    expect(hit).toBeDefined();
    await data.items.update(hit!.item.id, { body: 'Renewed the credential this year.' });
    expect(await data.items.search('Passed')).toEqual([]);
    expect((await data.items.search('renewed')).length).toBe(1);
    const reviewed = await data.items.markReviewed(hit!.item.id);
    expect(reviewed.verificationStatus).toBe('verified');
    expect(reviewed.lastReviewedAt).toBeInstanceOf(Date);
    expect(reviewed.publicUsePermitted).toBe(false);
  });
});

describe('item defaults', () => {
  it('are private, unverified and not permitted for public use when a bare item is inserted', async () => {
    const { knowledgeItems } = await import('../src/server/db/schema');
    const [row] = await handle.db.insert(knowledgeItems).values({ ownerId: OWNER, title: 'bare' }).returning();
    expect(row).toMatchObject({
      kind: 'note',
      confidentiality: 'private',
      verificationStatus: 'unverified',
      publicUsePermitted: false,
      tags: [],
      lastReviewedAt: null,
    });
  });
});

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { applyOwnerSeed, ownerSeedSchema, resolveDesignatedOwnerId, SeedRefusedError, type OwnerSeed } from '../src/server/data/seed';
import { forOwner } from '../src/server/data/tenant';
import { ensureLocalOwner, LOCAL_OWNER_ID } from '../src/server/data/users';
import type { DbHandle } from '../src/server/db/client';
import { users } from '../src/server/db/schema';
import { memoryDb, testConfig } from './helpers';

// Synthetic content only. The real seed lives in a gitignored file and is never used by tests.
const SYNTHETIC = ownerSeedSchema.parse({
  version: 1,
  profile: {
    name: 'Sample Person',
    headline: 'Synthetic headline for tests',
    yearsExperience: 7,
    location: 'Testville',
    careerGoals: 'Synthetic goal.',
    targetEmployers: ['Example Corp', 'Sample Labs'],
    expertiseAreas: ['widgets', 'gadgets'],
  },
  preferences: { tone: 'plain', audience: 'engineers', writingStyle: 'short sentences', avoid: ['hype'] },
  sources: [{ seedKey: 'src.site', kind: 'url', title: 'Example site', uri: 'https://example-blog.dev' }],
  items: [
    { seedKey: 'ach.one', kind: 'achievement', title: 'Synthetic result one', body: 'Claim number one, sparkplugzeta.', tags: ['a'], sourceKey: 'src.site' },
    { seedKey: 'ach.two', kind: 'achievement', title: 'Synthetic result two', body: 'Claim number two.', tags: [] },
    { seedKey: 'read.one', kind: 'reading', title: 'Synthetic book', body: '', tags: [] },
  ],
}) as OwnerSeed;

const open: DbHandle[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

async function localDb() {
  const handle = await memoryDb();
  open.push(handle);
  await ensureLocalOwner(handle.db);
  return handle;
}

const OTHER = '22222222-2222-4222-8222-222222222222';

async function addMember(handle: DbHandle, id: string, displayName: string, email: string) {
  await handle.db.insert(users).values({ id, kind: 'member', displayName, email });
}

describe('owner seed binding', () => {
  it('writes to the designated local owner and marks every item as a private owner claim', async () => {
    const handle = await localDb();
    const designated = await resolveDesignatedOwnerId(testConfig(), handle.db);
    expect(designated).toBe(LOCAL_OWNER_ID);

    const counts = await applyOwnerSeed(handle.db, { targetUserId: LOCAL_OWNER_ID, designatedOwnerId: designated, seed: SYNTHETIC });
    expect(counts).toEqual({ profile: 'created', preferences: 'created', sources: { created: 1, kept: 0 }, items: { created: 3, kept: 0 } });

    const data = forOwner(LOCAL_OWNER_ID, handle.db);
    const items = await data.items.list();
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item).toMatchObject({ confidentiality: 'private', publicUsePermitted: false, verificationStatus: 'owner_claim_needs_review' });
    }
    // Separate items, never combined into one.
    expect(new Set(items.map((i) => i.title)).size).toBe(3);
    expect((await data.items.counts()).needsReview).toBe(3);
    const linked = items.find((i) => i.seedKey === 'ach.one');
    expect(linked?.sourceId).toBeTruthy();
    expect((await data.profile.get())?.name).toBe('Sample Person');
    expect((await data.items.search('sparkplugzeta')).length).toBe(1);
  });

  it('is idempotent: a re-run changes nothing, and edits made since are kept', async () => {
    const handle = await localDb();
    const input = { targetUserId: LOCAL_OWNER_ID, designatedOwnerId: LOCAL_OWNER_ID, seed: SYNTHETIC };
    await applyOwnerSeed(handle.db, input);
    const data = forOwner(LOCAL_OWNER_ID, handle.db);
    const before = await data.items.list();
    const [first] = before;
    await data.items.update(first!.id, { title: 'Edited by the owner' });
    await data.profile.upsert({ name: 'Edited Name', headline: null, yearsExperience: null, location: null, careerGoals: null, targetEmployers: [], expertiseAreas: [] });

    const again = await applyOwnerSeed(handle.db, input);
    expect(again).toEqual({ profile: 'kept', preferences: 'kept', sources: { created: 0, kept: 1 }, items: { created: 0, kept: 3 } });

    const after = await data.items.list();
    expect(after).toHaveLength(3);
    expect(after.find((i) => i.id === first!.id)?.title).toBe('Edited by the owner');
    expect((await data.profile.get())?.name).toBe('Edited Name');
    expect((await data.sources.list()).length).toBe(1);

    // One audit event for the first run, none for the no-op re-run.
    const events = (await data.audit.list()).filter((e) => e.action === 'owner_seed.applied');
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]?.metadata)).not.toContain('Claim number');
  });

  it('refuses any user who is not the designated owner, and writes nothing', async () => {
    const handle = await localDb();
    await addMember(handle, OTHER, 'Sample Person', 'sample.person@example.test');
    await expect(
      applyOwnerSeed(handle.db, { targetUserId: OTHER, designatedOwnerId: LOCAL_OWNER_ID, seed: SYNTHETIC }),
    ).rejects.toBeInstanceOf(SeedRefusedError);
    expect(await forOwner(OTHER, handle.db).items.list()).toEqual([]);
    expect(await forOwner(OTHER, handle.db).profile.get()).toBeNull();
    expect(await forOwner(LOCAL_OWNER_ID, handle.db).items.list()).toEqual([]);
  });

  it('is bound to the id, never to a display name or email that matches the seed profile', async () => {
    const handle = await localDb();
    await addMember(handle, OTHER, SYNTHETIC.profile.name, 'name.twin@example.test');
    await expect(
      applyOwnerSeed(handle.db, { targetUserId: OTHER, designatedOwnerId: LOCAL_OWNER_ID, seed: SYNTHETIC }),
    ).rejects.toThrow(/not the designated owner/);
    expect(await forOwner(OTHER, handle.db).items.list()).toEqual([]);
  });

  it('refuses when nobody is designated, or the designated account does not exist', async () => {
    const handle = await localDb();
    await expect(applyOwnerSeed(handle.db, { targetUserId: LOCAL_OWNER_ID, designatedOwnerId: undefined, seed: SYNTHETIC })).rejects.toThrow(/no owner is designated/);
    await expect(applyOwnerSeed(handle.db, { targetUserId: OTHER, designatedOwnerId: OTHER, seed: SYNTHETIC })).rejects.toThrow(/no account/);
  });

  it('local mode designates the owner only while the owner flag is set', async () => {
    const handle = await localDb();
    await handle.db.update(users).set({ isOwner: false }).where(eq(users.id, LOCAL_OWNER_ID));
    expect(await resolveDesignatedOwnerId(testConfig(), handle.db)).toBeUndefined();
  });

  it('hosted mode designates by OWNER_USER_ID: that user is seeded, other members are refused', async () => {
    const handle = await memoryDb();
    open.push(handle);
    const ownerId = '33333333-3333-4333-8333-333333333333';
    await addMember(handle, ownerId, 'Hosted Owner', 'hosted.owner@example.test');
    await addMember(handle, OTHER, 'Hosted Member', 'hosted.member@example.test');
    const config = testConfig({ mode: 'hosted', ownerUserId: ownerId });
    const designated = await resolveDesignatedOwnerId(config, handle.db);
    expect(designated).toBe(ownerId);

    await expect(applyOwnerSeed(handle.db, { targetUserId: OTHER, designatedOwnerId: designated, seed: SYNTHETIC })).rejects.toBeInstanceOf(SeedRefusedError);
    await applyOwnerSeed(handle.db, { targetUserId: ownerId, designatedOwnerId: designated, seed: SYNTHETIC });
    expect((await forOwner(ownerId, handle.db).items.list()).length).toBe(3);
    // The second account starts empty and cannot see any of it.
    const member = forOwner(OTHER, handle.db);
    expect(await member.items.list()).toEqual([]);
    expect(await member.items.search('sparkplugzeta')).toEqual([]);
    expect(await member.profile.get()).toBeNull();
    expect((await member.exportAll()).items).toEqual([]);

    expect(await resolveDesignatedOwnerId(testConfig({ mode: 'hosted' }), handle.db)).toBeUndefined();
  });
});

describe('seed file shape', () => {
  it('cannot make anything public or permit public use', () => {
    const base = { version: 1, profile: { name: 'X' }, preferences: {} };
    const item = { seedKey: 'k.one', kind: 'note', title: 't' };
    expect(ownerSeedSchema.safeParse({ ...base, items: [{ ...item, confidentiality: 'public' }] }).success).toBe(false);
    expect(ownerSeedSchema.safeParse({ ...base, items: [{ ...item, publicUsePermitted: true }] }).success).toBe(false);
    expect(ownerSeedSchema.safeParse({ ...base, items: [item] }).success).toBe(true);
  });

  it('rejects duplicate seed keys and dangling source references', () => {
    const base = { version: 1, profile: { name: 'X' }, preferences: {} };
    const a = { seedKey: 'k.one', kind: 'note', title: 't' };
    expect(ownerSeedSchema.safeParse({ ...base, items: [a, a] }).success).toBe(false);
    expect(ownerSeedSchema.safeParse({ ...base, items: [{ ...a, sourceKey: 'missing.key' }] }).success).toBe(false);
  });
});

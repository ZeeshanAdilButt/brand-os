import type { Draft, LinkedinPayload } from '@cph/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.js';
import { openDb, type Db } from '../src/db/open.js';
import { createRepos, type AuditEntry, type Repos } from '../src/db/repos.js';
import { GateError } from '../src/gate/errors.js';
import { mintVerifiedApproval, type VerifiedApproval } from '../src/gate/verified.js';
import { BufferClient, BufferMutationError } from '../src/routes/buffer-client.js';
import {
  BUFFER_DRAFT_STATUS,
  BufferPublishNotSentError,
  BufferRoute,
  BufferStageError,
  type BufferAlert,
  type BufferRouteDeps,
  type PlatformsConfigPatch,
} from '../src/routes/buffer.js';
import { RouteRegistry } from '../src/routes/registry.js';
import { PLATFORM_TIMEOUT_MS, PlatformError, StageRefused } from '../src/routes/types.js';
import { MemoryKeyStore } from '../src/secrets/keystore.js';
import { SecretStore } from '../src/secrets/secret-store.js';
import { ApiBudget, BUFFER_QUOTA_HEADERS } from '../src/services/api-budget.js';
import { createHealthScheduler, DAILY_PROBE_MS, settingsMemory } from '../src/services/health-scheduler.js';
import { fixture, FakeBuffer } from './helpers/fake-buffer.js';

/** CPU-heavy tests (long loops, simulated days) get room on a loaded machine; the default 5 s stays for the rest. */
const HEAVY_TEST_MS = 60_000;

const FAKE_KEY = 'not-a-real-key-0123456789abcdef';
const ORG_ID = 'org-test-0001';
const CHANNEL_ID = 'chan-linkedin-0001';
const RECONNECT = 'Reconnect LinkedIn in Buffer: https://publish.buffer.com/channels';
const SHA = 'b'.repeat(64);
const START = new Date('2026-10-19T10:00:00.000Z');
const MIN = 60_000;

const LINK = {
  url: 'https://www.example-blog.dev/blog/fixture?utm_source=linkedin&utm_medium=social&utm_campaign=fixture',
  title: 'Fixture title ρ',
  description: 'Fixture description 🙂',
  thumbnailUrl: 'https://www.example-blog.dev/blog/fixture/cover.png',
};

function payload(over: Partial<LinkedinPayload> = {}): LinkedinPayload {
  return { text: 'A post about caching ρ 🙂\n\nhttps://www.example-blog.dev/blog/fixture', ...over };
}

function draft(over: Partial<Draft<LinkedinPayload>> = {}): Draft<LinkedinPayload> {
  return {
    id: 'draft-1',
    slug: 'fixture',
    platform: 'linkedin',
    account: 'default',
    route: 'buffer',
    kind: 'post',
    status: 'draft',
    payload: payload(),
    payloadSha256: SHA,
    authorship: 'ai-assisted',
    lint: [],
    createdAt: START.toISOString(),
    updatedAt: START.toISOString(),
    ...over,
  };
}

function approval(over: Partial<{ draftId: string; payloadSha256: string }> = {}): VerifiedApproval {
  return mintVerifiedApproval({
    approvalId: 'approval-1',
    draftId: over.draftId ?? 'draft-1',
    payloadSha256: over.payloadSha256 ?? SHA,
    mode: 'publish_now',
    scheduledAt: null,
  });
}

function lowQuota(): Headers {
  const names = BUFFER_QUOTA_HEADERS['24h'];
  return new Headers({ [names.limit]: '250', [names.remaining]: '40', [names.reset]: '3600' });
}

interface Rig {
  db: Db;
  repos: Repos;
  secrets: SecretStore;
  fake: FakeBuffer;
  budget: ApiBudget;
  route: BufferRoute;
  /** A new route over the same database, config and fake: a daemon restart. */
  restart: () => BufferRoute;
  failed: { draftId: string; reason: string }[];
  alerts: BufferAlert[];
  audits: AuditEntry[];
  saved: PlatformsConfigPatch[];
  config: () => Config;
  clock: { now: Date };
}

interface RigOptions {
  /** A key stored for the route. Default true. */
  stored?: boolean;
  /** The org id already cached in config. Default true. */
  org?: boolean;
  /** The LinkedIn channel already mapped. Default true. */
  mapped?: boolean;
  fetchFn?: (fake: FakeBuffer) => typeof fetch;
}

function rig(options: RigOptions = {}): Rig {
  const clock = { now: new Date(START) };
  const db = openDb(':memory:');
  const repos = createRepos(db, { now: () => clock.now.toISOString() });
  const secrets = new SecretStore(new MemoryKeyStore(), repos);
  secrets.ensureMasterKey();
  if (options.stored !== false) secrets.put('linkedin', 'default', { apiKey: FAKE_KEY });
  const fake = new FakeBuffer(FAKE_KEY);
  const budget = new ApiBudget(repos, () => clock.now);

  let config = ConfigSchema.parse({
    platforms: {
      ...(options.org === false ? {} : { buffer: { organizationId: ORG_ID } }),
      linkedin: { route: 'buffer', linkCard: true, ...(options.mapped === false ? {} : { bufferChannelId: CHANNEL_ID }) },
    },
  });
  const saved: PlatformsConfigPatch[] = [];
  const failed: Rig['failed'] = [];
  const alerts: BufferAlert[] = [];
  const audits: AuditEntry[] = [];

  const deps: BufferRouteDeps = {
    secrets,
    fetchFn: options.fetchFn?.(fake) ?? fake.fetchFn,
    now: () => clock.now,
    budget,
    config: () => config,
    saveConfig: (patch) => {
      saved.push(patch);
      const linkedin = config.platforms.linkedin;
      config = ConfigSchema.parse({
        ...config,
        platforms: {
          ...config.platforms,
          ...(patch.buffer === undefined ? {} : { buffer: { ...config.platforms.buffer, ...patch.buffer } }),
          ...(patch.linkedin === undefined ? {} : { linkedin: { route: 'buffer', linkCard: false, ...linkedin, ...patch.linkedin } }),
        },
      });
    },
    markFailed: (draftId, reason) => {
      failed.push({ draftId, reason });
    },
    audit: (entry) => {
      audits.push(entry);
    },
    alert: (alert) => {
      alerts.push(alert);
    },
    store: repos.settings,
  };
  const route = new BufferRoute(deps);
  return { db, repos, secrets, fake, budget, route, restart: () => new BufferRoute(deps), failed, alerts, audits, saved, config: () => config, clock };
}

let r: Rig;
beforeEach(() => {
  r = rig();
});
afterEach(() => {
  r.db.close();
});

/** The decoded `input` variable of a recorded createPost request. */
const createInput = (req: { variables: Record<string, unknown> | undefined }): Record<string, unknown> =>
  req.variables?.['input'] as Record<string, unknown>;

describe('BufferRoute identity', () => {
  it('is the buffer route for linkedin that costs nothing, and registers like any route', () => {
    expect(r.route.kind).toBe('buffer');
    expect(r.route.platform).toBe('linkedin');
    expect(r.route.costEstimate(draft())).toBe(0);
    expect(new RouteRegistry([r.route]).require('linkedin', 'buffer')).toBe(r.route);
  });
});

describe('connect and channel mapping', () => {
  it('calls organizations once and channels once, caches the org id in config, stores only the key', async () => {
    const x = rig({ stored: false, org: false, mapped: false });
    try {
      const health = await x.route.connect('default', { apiKey: FAKE_KEY, extra: 'ignored' });
      expect(x.fake.ops('Organizations')).toHaveLength(1);
      expect(x.fake.ops('Channels')).toHaveLength(1);
      expect(x.fake.calls).toBe(2);
      expect(x.saved).toEqual([{ buffer: { organizationId: ORG_ID } }]);
      expect(x.config().platforms.buffer?.organizationId).toBe(ORG_ID);
      expect(x.fake.ops('Channels')[0]?.query).toContain(ORG_ID);
      expect(x.secrets.get('linkedin', 'default')).toEqual({ apiKey: FAKE_KEY });
      // Connected to Buffer, but no channel is mapped yet: not green, and it says what to do.
      expect(health.state).toBe('not_configured');
      expect(health.nextAction).toMatch(/LinkedIn channel/i);
    } finally {
      x.db.close();
    }
  });

  it('lists only the LinkedIn channels for the mapping dropdown, from the connect-time call', async () => {
    const x = rig({ stored: false, org: false, mapped: false });
    try {
      await x.route.connect('default', { apiKey: FAKE_KEY });
      expect(x.route.linkedinChannels('default')).toEqual([{ id: CHANNEL_ID, name: 'The owner', service: 'linkedin', isDisconnected: false }]);
      expect(x.fake.calls).toBe(2);
    } finally {
      x.db.close();
    }
  });

  it('mapChannel saves the choice to config, turns health green, and makes no request', async () => {
    const x = rig({ stored: false, org: false, mapped: false });
    try {
      await x.route.connect('default', { apiKey: FAKE_KEY });
      const before = x.fake.calls;
      const health = x.route.mapChannel('default', CHANNEL_ID);
      expect(health).toMatchObject({ state: 'connected', who: 'The owner' });
      expect(x.saved.at(-1)).toEqual({ linkedin: { bufferChannelId: CHANNEL_ID } });
      expect(x.config().platforms.linkedin?.bufferChannelId).toBe(CHANNEL_ID);
      expect(x.route.lastHealth('default')?.health.state).toBe('connected');
      expect(x.fake.calls).toBe(before);
    } finally {
      x.db.close();
    }
  });

  it('mapChannel refuses an unknown channel and a channel that is not LinkedIn', async () => {
    const x = rig({ stored: false, org: false, mapped: false });
    try {
      await x.route.connect('default', { apiKey: FAKE_KEY });
      expect(() => x.route.mapChannel('default', 'chan-x-0001')).toThrow(/not a LinkedIn channel/);
      expect(() => x.route.mapChannel('default', 'nope')).toThrow(/not a LinkedIn channel/);
      expect(x.saved.filter((p) => p.linkedin !== undefined)).toEqual([]);
    } finally {
      x.db.close();
    }
  });

  it('a rejected key stores nothing, caches nothing, and reports needs_reconnect', async () => {
    const x = rig({ stored: false, org: false, mapped: false });
    try {
      const health = await x.route.connect('default', { apiKey: 'not-a-real-key-wrong' });
      expect(health.state).toBe('needs_reconnect');
      expect(x.secrets.get('linkedin', 'default')).toBeNull();
      expect(x.saved).toEqual([]);
    } finally {
      x.db.close();
    }
  });

  it('a rejected key does not overwrite a working stored key', async () => {
    const health = await r.route.connect('default', { apiKey: 'not-a-real-key-wrong' });
    expect(health.state).toBe('needs_reconnect');
    expect(r.secrets.get('linkedin', 'default')).toEqual({ apiKey: FAKE_KEY });
  });

  it('without an apiKey it is not_configured and makes no request', async () => {
    const health = await r.route.connect('default', {});
    expect(health.state).toBe('not_configured');
    expect(r.fake.calls).toBe(0);
  });

  it('an account with no organization is not_configured and stores nothing', async () => {
    const x = rig({ stored: false, org: false, mapped: false });
    try {
      x.fake.override = (req) => (req.op === 'Organizations' ? { status: 200, body: { data: { account: { organizations: [] } } } } : undefined);
      const health = await x.route.connect('default', { apiKey: FAKE_KEY });
      expect(health.state).toBe('not_configured');
      expect(x.secrets.get('linkedin', 'default')).toBeNull();
      expect(x.fake.ops('Channels')).toHaveLength(0);
    } finally {
      x.db.close();
    }
  });
});

describe('wire format', () => {
  it('every request is a POST to https://api.buffer.com with Authorization: Bearer <key>', async () => {
    const x = rig({ stored: false, org: false, mapped: false });
    try {
      await x.route.connect('default', { apiKey: FAKE_KEY });
      x.route.mapChannel('default', CHANNEL_ID);
      await x.route.health('default');
      await x.route.stage(draft());
      await x.route.publish(draft(), approval());
      await x.route.cancelScheduled(draft({ remoteScheduledId: 'post-sched-1' }));
      await x.route.checkOnPlatform(draft({ remoteScheduledId: 'post-1' }));
      const ops = x.fake.requests.map((q) => q.op);
      expect(ops).toEqual([
        'Organizations',
        'Channels',
        'Channels', // health
        'CreatePost', // stage
        'Channels', // pre-publish probe
        'CreatePost', // publish
        'DeletePost',
        'GetPost',
      ]);
      for (const req of x.fake.requests) {
        expect(req.method).toBe('POST');
        expect(req.url).toBe('https://api.buffer.com');
        expect(req.headers['authorization']).toBe(`Bearer ${FAKE_KEY}`);
      }
    } finally {
      x.db.close();
    }
  });

  it('the key appears nowhere in a request body', async () => {
    await r.route.health('default');
    await r.route.publish(draft(), approval());
    for (const req of r.fake.requests) expect(req.raw).not.toContain(FAKE_KEY);
  });
});

describe('health (metered probe)', () => {
  it('makes exactly one request, channels with the cached org id, and never organizations', async () => {
    const health = await r.route.health('default');
    expect(health).toMatchObject({ state: 'connected', who: 'The owner' });
    expect(r.fake.calls).toBe(1);
    expect(r.fake.requests[0]?.op).toBe('Channels');
    expect(r.fake.requests[0]?.query).toContain(ORG_ID);
    expect(r.fake.ops('Organizations')).toHaveLength(0);
  });

  it('caches the result for cph status and the dashboard, with the time it was taken', async () => {
    expect(r.route.lastHealth('default')).toBeUndefined();
    await r.route.health('default');
    expect(r.route.lastHealth('default')).toEqual({ health: { state: 'connected', who: 'The owner' }, checkedAt: START.toISOString() });
    expect(r.fake.calls).toBe(1);
  });

  it('a disconnected channel is needs_reconnect with the deep link', async () => {
    r.fake.channels = r.fake.channels.map((c) => (c.id === CHANNEL_ID ? { ...c, isDisconnected: true } : c));
    const health = await r.route.health('default');
    expect(health.state).toBe('needs_reconnect');
    expect(health.nextAction).toBe(RECONNECT);
  });

  it('a channel that is gone from Buffer is needs_reconnect with the deep link', async () => {
    r.fake.channels = r.fake.channels.filter((c) => c.id !== CHANNEL_ID);
    const health = await r.route.health('default');
    expect(health.state).toBe('needs_reconnect');
    expect(health.nextAction).toBe(RECONNECT);
  });

  it('without a stored key, a cached org id or a mapped channel it is not_configured and makes no request', async () => {
    for (const options of [{ stored: false }, { org: false }] as const) {
      const x = rig(options);
      try {
        expect((await x.route.health('default')).state).toBe('not_configured');
        expect(x.fake.calls).toBe(0);
      } finally {
        x.db.close();
      }
    }
    const y = rig({ mapped: false });
    try {
      const health = await y.route.health('default');
      expect(health.state).toBe('not_configured');
      expect(y.fake.calls).toBe(1); // the probe ran; the mapping is what is missing
    } finally {
      y.db.close();
    }
  });

  it('a 401 is needs_reconnect, not a throw', async () => {
    r.secrets.put('linkedin', 'default', { apiKey: 'not-a-real-key-revoked' });
    const health = await r.route.health('default');
    expect(health.state).toBe('needs_reconnect');
  });

  it('a 5xx is thrown as a PlatformError and nothing is cached from it', async () => {
    r.fake.override = () => ({ status: 503, body: { errors: [{ message: 'down' }] } });
    await expect(r.route.health('default')).rejects.toBeInstanceOf(PlatformError);
    expect(r.route.lastHealth('default')).toBeUndefined();
  });
});

describe('publish', () => {
  it('sends shareNow exactly once, after one channels probe, with no assets, and returns the post id', async () => {
    const publication = await r.route.publish(draft(), approval());
    expect(publication).toEqual({ remoteId: 'post-sent-0001', costUsd: 0 });
    expect(r.fake.requests.map((q) => q.op)).toEqual(['Channels', 'CreatePost']);
    const creates = r.fake.ops('CreatePost');
    expect(creates).toHaveLength(1);
    const input = createInput(creates[0] as never);
    expect(input).toMatchObject({ channelId: CHANNEL_ID, mode: 'shareNow', schedulingType: 'automatic' });
    expect(input).not.toHaveProperty('assets');
    expect(input).not.toHaveProperty('saveToDraft');
  });

  it('a shareNow answered with a draft post is not published: BufferPublishNotSentError, nothing marked failed', async () => {
    r.fake.createPostReply = fixture('buffer-createPost-draft');
    const error = await r.route.publish(draft(), approval()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BufferPublishNotSentError);
    expect((error as Error).message).toContain('post-draft-0001');
    expect(r.failed).toEqual([]);
    expect(r.fake.ops('CreatePost')).toHaveLength(1);
  });

  it('never retries: a 500 on createPost is one request and a PlatformError', async () => {
    r.fake.override = (req) => (req.op === 'CreatePost' ? { status: 500, body: { errors: [{ message: 'boom' }] } } : undefined);
    await expect(r.route.publish(draft(), approval())).rejects.toBeInstanceOf(PlatformError);
    expect(r.fake.ops('CreatePost')).toHaveLength(1);
    // An ambiguous failure is not marked failed by the route; the publish service decides (unknown).
    expect(r.failed).toEqual([]);
  });

  it('never retries a network failure either', async () => {
    let attempts = 0;
    const x = rig({
      fetchFn: (fake) => (input, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        if (body.includes('mutation CreatePost')) {
          attempts++;
          return Promise.reject(new Error('socket hang up'));
        }
        return fake.fetchFn(input, init);
      },
    });
    try {
      await expect(x.route.publish(draft(), approval())).rejects.toThrow(/socket hang up/);
      expect(attempts).toBe(1);
      expect(x.failed).toEqual([]);
    } finally {
      x.db.close();
    }
  });

  it('HTTP 200 with a MutationError gives a BufferMutationError with the message, and marks the draft failed', async () => {
    r.fake.createPostReply = fixture('buffer-createPost-mutationError');
    const error = await r.route.publish(draft(), approval()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BufferMutationError);
    expect((error as Error).message).toContain('The channel is disconnected, so the post could not be created.');
    expect(r.failed).toEqual([{ draftId: 'draft-1', reason: (error as Error).message }]);
    expect(r.fake.ops('CreatePost')).toHaveLength(1);
  });

  it('refuses a disconnected channel before sending anything (UNHEALTHY with the deep link)', async () => {
    r.fake.channels = r.fake.channels.map((c) => (c.id === CHANNEL_ID ? { ...c, isDisconnected: true } : c));
    const error = await r.route.publish(draft(), approval()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe('UNHEALTHY');
    expect((error as Error).message).toContain('https://publish.buffer.com/channels');
    expect(r.fake.ops('CreatePost')).toHaveLength(0);
  });

  it('refuses when no LinkedIn channel is mapped', async () => {
    const x = rig({ mapped: false });
    try {
      await expect(x.route.publish(draft(), approval())).rejects.toBeInstanceOf(GateError);
      expect(x.fake.ops('CreatePost')).toHaveLength(0);
    } finally {
      x.db.close();
    }
  });

  it('a forged approval, one for another draft, or one for a changed hash sends nothing', async () => {
    const forged = { approvalId: 'x', draftId: 'draft-1', payloadSha256: SHA, mode: 'publish_now', scheduledAt: null } as unknown as VerifiedApproval;
    await expect(r.route.publish(draft(), forged)).rejects.toThrow(TypeError);
    await expect(r.route.publish(draft(), approval({ draftId: 'other' }))).rejects.toMatchObject({ code: 'NO_APPROVAL' });
    await expect(r.route.publish(draft(), approval({ payloadSha256: 'c'.repeat(64) }))).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    expect(r.fake.calls).toBe(0);
  });

  it('is not connected without a stored key', async () => {
    const x = rig({ stored: false });
    try {
      await expect(x.route.publish(draft(), approval())).rejects.toThrow(/not connected/);
      expect(x.fake.calls).toBe(0);
    } finally {
      x.db.close();
    }
  });
});

describe('route contract: what was approved is what is sent', () => {
  // A new payload field makes this fail to compile until the test (and the route) handle it.
  const full = { text: 'Contract text ρ 🙂 https://www.example-blog.dev/blog/fixture', link: LINK } satisfies Record<keyof LinkedinPayload, unknown>;
  const linkKeys = { url: 1, title: 1, description: 1, thumbnailUrl: 1 } satisfies Record<keyof typeof LINK, unknown>;

  it('publish: text and every link field reach the wire', async () => {
    await r.route.publish(draft({ payload: full }), approval());
    const wire = createInput(r.fake.ops('CreatePost')[0] as never);
    expect(wire['text']).toBe(full.text);
    const attachment = (wire['metadata'] as { linkedin: { linkAttachment: Record<string, string> } }).linkedin.linkAttachment;
    for (const key of Object.keys(linkKeys) as (keyof typeof LINK)[]) expect(attachment[key]).toBe(LINK[key]);
    // And in the raw bytes, so a rename or an encoding slip cannot hide.
    const raw = r.fake.ops('CreatePost')[0]?.raw ?? '';
    for (const value of [full.text, LINK.url, LINK.title, LINK.description, LINK.thumbnailUrl]) {
      expect(raw).toContain(JSON.stringify(value).slice(1, -1));
    }
    expect(wire).not.toHaveProperty('assets');
  });

  it('stage: the same fields reach the wire', async () => {
    await r.route.stage(draft({ payload: full }));
    const wire = createInput(r.fake.ops('CreatePost')[0] as never);
    expect(wire['text']).toBe(full.text);
    expect((wire['metadata'] as { linkedin: { linkAttachment: unknown } }).linkedin.linkAttachment).toEqual(LINK);
  });

  it('with the link absent no metadata.linkedin is sent', async () => {
    await r.route.publish(draft({ payload: { text: 'No card' } }), approval());
    const wire = createInput(r.fake.ops('CreatePost')[0] as never);
    expect(wire['text']).toBe('No card');
    expect(wire).not.toHaveProperty('metadata');
    expect(r.fake.ops('CreatePost')[0]?.raw).not.toContain('linkAttachment');
  });
});

describe('stage (private draft)', () => {
  it('sends saveToDraft:true with addToQueue and never shareNow, and returns the draft id', async () => {
    const ref = await r.route.stage(draft());
    expect(ref).toEqual({ remoteId: 'post-draft-0001' });
    const creates = r.fake.ops('CreatePost');
    expect(creates).toHaveLength(1);
    const input = createInput(creates[0] as never);
    expect(input).toMatchObject({ channelId: CHANNEL_ID, mode: 'addToQueue', saveToDraft: true, schedulingType: 'automatic' });
    expect(creates[0]?.raw).not.toContain('shareNow');
    expect(input).not.toHaveProperty('assets');
    expect(BUFFER_DRAFT_STATUS).toBe('draft');
    expect(r.fake.ops('DeletePost')).toHaveLength(0);
    expect(r.failed).toEqual([]);
  });

  it.each(['scheduled', 'sent', 'sending', 'queued', ''])(
    'status %j instead of draft: deletePost once, the draft is failed, an audit entry and an alert are written',
    async (status) => {
      r.fake.createPostReply = { data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'post-queued-0001', status } } } };
      const error = await r.route.stage(draft()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BufferStageError);

      const deletes = r.fake.ops('DeletePost');
      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.query).toContain('post-queued-0001');
      expect(r.failed).toEqual([{ draftId: 'draft-1', reason: 'Buffer did not save this as a draft; it was deleted' }]);
      expect(r.audits).toHaveLength(1);
      expect(r.audits[0]).toMatchObject({ action: 'buffer_stage_not_draft', draftId: 'draft-1', platform: 'linkedin' });
      expect(r.audits[0]?.detail).toMatchObject({ postId: 'post-queued-0001', status, deleted: true });
      expect(r.alerts).toHaveLength(1);
      expect(r.alerts[0]).toMatchObject({ level: 'warning' });
      expect(r.alerts[0]?.message).toContain('it was deleted');
    },
  );

  it('if the delete also fails: red alert and failure reason say to delete it by hand in Buffer now, with a link', async () => {
    r.fake.createPostReply = fixture('buffer-createPost-notDraft');
    r.fake.deleteReply = { data: { deletePost: { __typename: 'MutationError', message: 'Post cannot be deleted' } } };
    await expect(r.route.stage(draft())).rejects.toBeInstanceOf(BufferStageError);
    expect(r.fake.ops('DeletePost')).toHaveLength(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.reason).toContain('Delete it by hand in Buffer now');
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({ level: 'critical', link: 'https://publish.buffer.com' });
    expect(r.alerts[0]?.message).toContain('Delete it by hand in Buffer now');
    expect(r.audits[0]).toMatchObject({ action: 'buffer_stage_not_draft' });
    expect(r.audits[0]?.detail).toMatchObject({ postId: 'post-queued-0001', deleted: false });
  });

  it('if the delete call itself errors (HTTP 500), the same red path runs', async () => {
    r.fake.createPostReply = fixture('buffer-createPost-notDraft');
    r.fake.override = (req) => (req.op === 'DeletePost' ? { status: 500, body: {} } : undefined);
    await expect(r.route.stage(draft())).rejects.toBeInstanceOf(BufferStageError);
    expect(r.alerts[0]?.level).toBe('critical');
    expect(r.failed[0]?.reason).toContain('Delete it by hand in Buffer now');
  });

  it('a MutationError on stage marks the draft failed and creates nothing to delete', async () => {
    r.fake.createPostReply = fixture('buffer-createPost-mutationError');
    await expect(r.route.stage(draft())).rejects.toBeInstanceOf(BufferMutationError);
    expect(r.failed).toHaveLength(1);
    expect(r.fake.ops('DeletePost')).toHaveLength(0);
  });

  it.each(['pending_approval', 'approved', 'scheduled', 'publishing', 'unknown', 'published', 'failed', 'held', 'source_changed', 'handed_off'] as const)(
    'refuses a draft in status %s without any request',
    async (status) => {
      await expect(r.route.stage(draft({ status }))).rejects.toBeInstanceOf(StageRefused);
      expect(r.fake.calls).toBe(0);
    },
  );

  it('re-staging creates the new draft first, then deletes the old private one', async () => {
    const ref = await r.route.stage(draft({ status: 'staged', remoteRef: 'post-old-0001' }));
    expect(ref.remoteId).toBe('post-draft-0001');
    expect(r.fake.requests.map((q) => q.op)).toEqual(['CreatePost', 'DeletePost']);
    expect(r.fake.ops('DeletePost')[0]?.query).toContain('post-old-0001');
  });

  it('a failed cleanup of the old draft does not fail the stage; it is audited', async () => {
    r.fake.deleteReply = { data: { deletePost: { __typename: 'MutationError', message: 'nope' } } };
    const ref = await r.route.stage(draft({ status: 'staged', remoteRef: 'post-old-0001' }));
    expect(ref.remoteId).toBe('post-draft-0001');
    expect(r.audits.map((a) => a.action)).toEqual(['buffer_old_draft_not_deleted']);
    expect(r.failed).toEqual([]);
  });
});

describe('cancelScheduled and checkOnPlatform', () => {
  it('cancelScheduled deletes the remote scheduled post by id', async () => {
    await r.route.cancelScheduled(draft({ remoteScheduledId: 'post-sched-0001' }));
    expect(r.fake.ops('DeletePost')).toHaveLength(1);
    expect(r.fake.ops('DeletePost')[0]?.query).toContain('post-sched-0001');
  });

  it('cancelScheduled without a remote scheduled id throws and sends nothing', async () => {
    await expect(r.route.cancelScheduled(draft())).rejects.toThrow(/scheduled/);
    expect(r.fake.calls).toBe(0);
  });

  it('cancelScheduled surfaces a failed delete (the caller shows the red card)', async () => {
    r.fake.deleteReply = { data: { deletePost: { __typename: 'MutationError', message: 'cannot delete' } } };
    await expect(r.route.cancelScheduled(draft({ remoteScheduledId: 'p1' }))).rejects.toBeInstanceOf(BufferMutationError);
  });

  it('checkOnPlatform: only the scheduled post id can answer; sent is published, draft is not_found, missing or anything else is unknown', async () => {
    const check = (d: Draft<LinkedinPayload>) => r.route.checkOnPlatform(d);
    expect(await check(draft())).toBe('unknown');
    expect(r.fake.calls).toBe(0);

    const scheduled = (): Draft<LinkedinPayload> => draft({ remoteScheduledId: 'p1' });
    r.fake.getPostReply = { data: { post: { id: 'p1', status: 'sent' } } };
    expect(await check(scheduled())).toBe('published');
    r.fake.getPostReply = { data: { post: { id: 'p1', status: 'draft' } } };
    expect(await check(scheduled())).toBe('not_found');
    // No post for the id is not proof that nothing went out.
    r.fake.getPostReply = { data: { post: null } };
    expect(await check(scheduled())).toBe('unknown');
    r.fake.getPostReply = { data: { post: { id: 'p1', status: 'sending' } } };
    expect(await check(scheduled())).toBe('unknown');
  });

  it('checkOnPlatform never reads the private staged draft: its state says nothing about the shareNow post', async () => {
    // After a 5xx/network publish the staged draft still reads "draft"; that must not become not_found.
    r.fake.getPostReply = { data: { post: { id: 'post-draft-0001', status: 'draft' } } };
    expect(await r.route.checkOnPlatform(draft({ status: 'unknown', remoteRef: 'post-draft-0001' }))).toBe('unknown');
    expect(r.fake.calls).toBe(0);
  });

  it('checkOnPlatform is refused with zero requests when the budget is low (it is a non-publish call)', async () => {
    r.budget.record('buffer', lowQuota());
    const error = await r.route.checkOnPlatform(draft({ remoteScheduledId: 'p1' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe('BUDGET_LOW');
    expect(r.fake.calls).toBe(0);
  });

  it('checkOnPlatform treats a schema error as unknown, not a crash', async () => {
    r.fake.override = (req) => (req.op === 'GetPost' ? { status: 200, body: { errors: [{ message: 'Cannot query field "post"' }] } } : undefined);
    expect(await r.route.checkOnPlatform(draft({ remoteScheduledId: 'p1' }))).toBe('unknown');
  });
});

describe('the API key never appears in an error', () => {
  const expectClean = async (run: () => Promise<unknown>): Promise<void> => {
    const error = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const text = `${(error as Error).message}\n${(error as Error).stack ?? ''}\n${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
    expect(text).not.toContain(FAKE_KEY);
  };

  it('in an HTTP error body that echoes the key and the Authorization header', async () => {
    r.fake.override = () => ({ status: 502, body: { error: `bad gateway for Authorization: Bearer ${FAKE_KEY} and key ${FAKE_KEY}` } });
    await expectClean(() => r.route.health('default'));
    await expectClean(() => r.route.stage(draft()));
    await expectClean(() => r.route.publish(draft(), approval()));
  });

  it('in a network failure', async () => {
    const x = rig({ fetchFn: () => () => Promise.reject(new Error(`connect ECONNRESET sending Bearer ${FAKE_KEY}`)) });
    try {
      await expectClean(() => x.route.health('default'));
      await expectClean(() => x.route.publish(draft(), approval()));
    } finally {
      x.db.close();
    }
  });

  it('in a MutationError message and in GraphQL errors', async () => {
    r.fake.createPostReply = { data: { createPost: { __typename: 'MutationError', message: `rejected ${FAKE_KEY}` } } };
    await expectClean(() => r.route.stage(draft()));
    r.fake.override = () => ({ status: 200, body: { errors: [{ message: `Invalid token ${FAKE_KEY}` }] } });
    await expectClean(() => r.route.health('default'));
  });

  it('BufferClient scrubs the key it was built with', async () => {
    const budget = new ApiBudget(r.repos, () => r.clock.now);
    const client = new BufferClient(FAKE_KEY, () => Promise.reject(new Error(`oops ${FAKE_KEY}`)), budget);
    await expectClean(() => client.organizations());
  });
});

describe('API budget guard', () => {
  it('with 40 of 250 left in 24 h, a probe and a stage throw BUDGET_LOW without a request, and a publish goes out', async () => {
    r.budget.record('buffer', lowQuota());
    const before = r.fake.calls;

    const probe = await r.route.health('default').catch((e: unknown) => e);
    expect(probe).toBeInstanceOf(GateError);
    expect((probe as GateError).code).toBe('BUDGET_LOW');
    const stage = await r.route.stage(draft()).catch((e: unknown) => e);
    expect(stage).toBeInstanceOf(GateError);
    expect((stage as GateError).code).toBe('BUDGET_LOW');
    expect(r.fake.calls).toBe(before);

    // The publish (its pre-publish probe included) is never refused by the guard.
    const publication = await r.route.publish(draft(), approval());
    expect(publication.remoteId).toBe('post-sent-0001');
    expect(r.fake.requests.map((q) => q.op)).toEqual(['Channels', 'CreatePost']);
  });

  it('learns the quota from the response headers of an ordinary call', async () => {
    const names = BUFFER_QUOTA_HEADERS['24h'];
    r.fake.quotaHeaders = { [names.limit]: '250', [names.remaining]: '40', [names.reset]: '3600' };
    await r.route.health('default'); // allowed: nothing was known yet
    expect(r.budget.snapshot('buffer').d1).toEqual({ limit: 250, remaining: 40 });
    const calls = r.fake.calls;
    await expect(r.route.health('default')).rejects.toMatchObject({ code: 'BUDGET_LOW' });
    expect(r.fake.calls).toBe(calls);
  });

  it('cleanup of a bad stage and cancelling a scheduled post are not refused when the budget is low', async () => {
    r.fake.createPostReply = fixture('buffer-createPost-notDraft');
    // Stage is allowed while the budget is fine; then the quota drops before the cleanup.
    r.fake.override = (req) => {
      if (req.op === 'CreatePost') r.budget.record('buffer', lowQuota());
      return undefined;
    };
    await expect(r.route.stage(draft())).rejects.toBeInstanceOf(BufferStageError);
    expect(r.fake.ops('DeletePost')).toHaveLength(1);
    expect(r.failed[0]?.reason).toBe('Buffer did not save this as a draft; it was deleted');
    await r.route.cancelScheduled(draft({ remoteScheduledId: 'p9' }));
    expect(r.fake.ops('DeletePost')).toHaveLength(2);
  });
});

describe('health scheduler (the timer the daemon will run)', () => {
  it('probes on the first tick, then at most once per interval', async () => {
    const probes: string[] = [];
    const scheduler = createHealthScheduler({
      route: { health: (account) => Promise.resolve(void probes.push(account)) },
      account: 'default',
      now: () => r.clock.now,
    });
    expect(await scheduler.tick()).toBe('probed');
    r.clock.now = new Date(r.clock.now.getTime() + 15 * MIN);
    expect(await scheduler.tick()).toBe('skipped');
    r.clock.now = new Date(START.getTime() + DAILY_PROBE_MS - 1);
    expect(await scheduler.tick()).toBe('skipped');
    r.clock.now = new Date(START.getTime() + DAILY_PROBE_MS);
    expect(await scheduler.tick()).toBe('probed');
    expect(probes).toEqual(['default', 'default']);
  });

  it('a failed probe counts as an attempt and is reported through onError, never thrown', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const scheduler = createHealthScheduler({
      route: {
        health: () => {
          calls++;
          return Promise.reject(new Error('boom'));
        },
      },
      account: 'default',
      now: () => r.clock.now,
      onError: (e) => errors.push(e),
    });
    expect(await scheduler.tick()).toBe('failed');
    r.clock.now = new Date(r.clock.now.getTime() + 15 * MIN);
    expect(await scheduler.tick()).toBe('skipped');
    expect(calls).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('the cached probe result and channel list survive a restart, so status, the dropdown and mapChannel work at once', async () => {
    const x = rig({ mapped: false });
    try {
      await x.route.health('default');
      const restarted = x.restart();
      const calls = x.fake.calls;
      expect(restarted.lastHealth('default')).toMatchObject({ health: { state: 'not_configured' }, checkedAt: START.toISOString() });
      expect(restarted.linkedinChannels('default').map((c) => c.id)).toEqual([CHANNEL_ID]);
      expect(restarted.mapChannel('default', CHANNEL_ID)).toMatchObject({ state: 'connected', who: 'The owner' });
      // mapChannel's re-evaluation is cached too, for the next restart.
      expect(x.restart().lastHealth('default')?.health.state).toBe('connected');
      expect(x.fake.calls).toBe(calls);
    } finally {
      x.db.close();
    }
  });

  it('an unreadable stored cache is ignored, not a crash', () => {
    r.repos.settings.set('buffer_probe_cache:default', '{not json');
    expect(r.restart().lastHealth('default')).toBeUndefined();
    r.repos.settings.set('buffer_probe_cache:default', JSON.stringify({ health: 3 }));
    expect(r.restart().linkedinChannels('default')).toEqual([]);
  });

  it('remembers the last probe across a restart', async () => {
    const memory = settingsMemory(r.repos, 'health_probe:buffer');
    const make = () => createHealthScheduler({ route: r.route, account: 'default', now: () => r.clock.now, memory });
    expect(await make().tick()).toBe('probed');
    r.clock.now = new Date(r.clock.now.getTime() + 60 * MIN);
    expect(await make().tick()).toBe('skipped');
    expect(r.fake.calls).toBe(1);
  });
});

describe('30-day simulation (Review Focus #9)', { timeout: HEAVY_TEST_MS }, () => {
  it('30 days of uptime with nothing published: at most 300 Buffer calls (about one a day), with restarts and no headers', async () => {
    const memory = settingsMemory(r.repos, 'health_probe:buffer');
    // A restart rebuilds the route and the scheduler, as the daemon would.
    const make = (route: BufferRoute) => createHealthScheduler({ route, account: 'default', now: () => r.clock.now, memory });
    let route = r.route;
    let scheduler = make(route);
    const TICKS = 30 * 24 * 4; // the daemon's 15-minute timer
    for (let i = 0; i < TICKS; i++) {
      r.clock.now = new Date(r.clock.now.getTime() + 15 * MIN);
      if (i % 24 === 0) {
        // the daemon restarts every 6 hours
        route = r.restart();
        scheduler = make(route);
        if (i > 0) expect(route.lastHealth('default')).toBeDefined();
      }
      await scheduler.tick();
    }
    expect(route.lastHealth('default')?.health.state).toBe('connected');
    expect(r.fake.calls).toBeLessThanOrEqual(300);
    expect(r.fake.calls).toBeGreaterThanOrEqual(29);
    expect(r.fake.ops('Organizations')).toHaveLength(0);
    expect(r.fake.ops('CreatePost')).toHaveLength(0);
    // The budget agrees with the fake, from local counting alone (it sent no quota headers).
    const { d30 } = r.budget.snapshot('buffer');
    expect(d30.limit - d30.remaining).toBe(Math.min(r.fake.calls, 3000));
    expect(r.budget.allows('buffer', 'probe')).toBe(true);
  });

  it('a runaway prober (every 5 minutes) is stopped by the guard, and a publish still goes out afterwards', async () => {
    const times: number[] = [];
    r.fake.override = () => {
      times.push(r.clock.now.getTime());
      return undefined;
    };
    for (let i = 0; i < 3 * 24 * 12; i++) {
      r.clock.now = new Date(r.clock.now.getTime() + 5 * MIN);
      await r.route.health('default').catch((e: unknown) => {
        if (!(e instanceof GateError && e.code === 'BUDGET_LOW')) throw e;
      });
    }
    // In any 24 h window the guard lets at most 80% of 250 (+1) through.
    for (const t of times) {
      const inWindow = times.filter((u) => u <= t && u > t - 24 * 60 * MIN).length;
      expect(inWindow).toBeLessThanOrEqual(201);
    }
    expect(times.length).toBeLessThan(3 * 24 * 12);
    const publication = await r.route.publish(draft(), approval());
    expect(publication.remoteId).toBe('post-sent-0001');
  });
});

describe('request hardening', () => {
  it('every Buffer request refuses redirects and carries a timeout signal', async () => {
    const inits: RequestInit[] = [];
    const x = rig({
      stored: false,
      org: false,
      mapped: false,
      fetchFn: (fake) => (input, init) => {
        inits.push(init ?? {});
        return fake.fetchFn(input, init);
      },
    });
    try {
      await x.route.connect('default', { apiKey: FAKE_KEY });
      x.route.mapChannel('default', CHANNEL_ID);
      await x.route.stage(draft());
      await x.route.publish(draft(), approval());
      expect(inits.length).toBeGreaterThanOrEqual(5);
      for (const init of inits) {
        expect(init.redirect).toBe('error');
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.signal?.aborted).toBe(false);
      }
    } finally {
      x.db.close();
    }
    expect(PLATFORM_TIMEOUT_MS).toBe(30_000);
  });

  it('a request that times out is an ordinary error (the publish service makes it unknown), never a clean refusal', async () => {
    const x = rig({
      fetchFn: (fake) => (input, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        if (body.includes('mutation CreatePost')) return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        return fake.fetchFn(input, init);
      },
    });
    try {
      const error = await x.route.publish(draft(), approval()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PlatformError);
      expect(error).not.toBeInstanceOf(BufferMutationError);
      expect((error as Error).message).toMatch(/timeout/);
      expect(x.failed).toEqual([]);
    } finally {
      x.db.close();
    }
  });
});

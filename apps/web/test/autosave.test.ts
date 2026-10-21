import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { draftDiff, SaveController, type ControllerStatus, type Draft, type SendOutcome, type SendRequest } from '../src/lib/autosave';

const base: Draft = {
  title: 'Title',
  slug: 'title',
  description: '',
  tags: [],
  canonicalUrl: null,
  coverAssetId: null,
  status: 'draft',
  bodyMarkdown: 'start',
};

interface Harness {
  controller: SaveController;
  requests: SendRequest[];
  statuses: ControllerStatus[];
  respond: (outcome: (request: SendRequest) => SendOutcome | Promise<SendOutcome>) => void;
  server: { draft: Draft; revision: number };
}

function setup(): Harness {
  const server = { draft: base, revision: 1 };
  const requests: SendRequest[] = [];
  const statuses: ControllerStatus[] = [];
  let responder: (request: SendRequest) => SendOutcome | Promise<SendOutcome> = (request) => {
    if (request.expectedRevision !== server.revision) return { kind: 'conflict', revision: server.revision, draft: server.draft };
    server.draft = { ...server.draft, ...request.patch };
    server.revision += 1;
    return { kind: 'ok', revision: server.revision, draft: server.draft };
  };
  const controller = new SaveController({
    initial: { draft: base, revision: 1 },
    send: async (request) => {
      requests.push(request);
      return responder(request);
    },
    onChange: (status) => statuses.push(status),
  });
  return { controller, requests, statuses, respond: (fn) => (responder = fn), server };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('draftDiff', () => {
  it('lists only changed fields, comparing tags by value', () => {
    expect(draftDiff(base, { ...base, tags: [] })).toEqual({});
    expect(draftDiff(base, { ...base, tags: ['a'], title: 'New' })).toEqual({ tags: ['a'], title: 'New' });
    expect(draftDiff(base, { ...base, title: 'New' }, new Set(['title']))).toEqual({});
  });
});

describe('autosave', () => {
  it('waits for a quiet moment, then sends one save with only the changed fields', async () => {
    const h = setup();
    h.controller.edit({ ...base, bodyMarkdown: 'a' });
    h.controller.edit({ ...base, bodyMarkdown: 'ab' });
    h.controller.edit({ ...base, bodyMarkdown: 'abc' });
    expect(h.controller.getStatus().state).toBe('dirty');
    await vi.advanceTimersByTimeAsync(1400);
    expect(h.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.requests).toEqual([{ patch: { bodyMarkdown: 'abc' }, expectedRevision: 1, reason: 'autosave' }]);
    expect(h.controller.getStatus()).toMatchObject({ state: 'saved', revision: 2 });
    expect(h.statuses.map((s) => s.state)).toEqual(['dirty', 'dirty', 'dirty', 'saving', 'saved']);
  });

  it('returns to saved without a request when the text is typed and then undone', async () => {
    const h = setup();
    h.controller.edit({ ...base, bodyMarkdown: 'x' });
    h.controller.edit(base);
    expect(h.controller.getStatus().state).toBe('saved');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.requests).toHaveLength(0);
  });

  it('keeps typing during a request and sends the rest afterwards, with the new revision', async () => {
    const h = setup();
    let release: (() => void) | null = null;
    h.respond(
      (request) =>
        new Promise<SendOutcome>((resolve) => {
          release = () => {
            h.server.draft = { ...h.server.draft, ...request.patch };
            h.server.revision += 1;
            resolve({ kind: 'ok', revision: h.server.revision, draft: h.server.draft });
          };
        }),
    );
    h.controller.edit({ ...base, bodyMarkdown: 'one' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.controller.getStatus().state).toBe('saving');
    h.controller.edit({ ...base, bodyMarkdown: 'one two' });
    expect(h.requests).toHaveLength(1);
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getStatus().state).toBe('dirty');
    h.respond((request) => {
      h.server.draft = { ...h.server.draft, ...request.patch };
      h.server.revision += 1;
      return { kind: 'ok', revision: h.server.revision, draft: h.server.draft };
    });
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]).toMatchObject({ patch: { bodyMarkdown: 'one two' }, expectedRevision: 2 });
    expect(h.controller.getStatus().state).toBe('saved');
  });

  it('saveNow sends immediately as a deliberate save, even with nothing new to send', async () => {
    const h = setup();
    h.controller.edit({ ...base, title: 'Renamed' });
    await h.controller.saveNow();
    expect(h.requests).toEqual([{ patch: { title: 'Renamed' }, expectedRevision: 1, reason: 'manual' }]);
    await h.controller.saveNow();
    expect(h.requests[1]).toEqual({ patch: {}, expectedRevision: 2, reason: 'manual' });
  });

  it('flush sends pending edits at once', async () => {
    const h = setup();
    h.controller.edit({ ...base, bodyMarkdown: 'leaving soon' });
    await h.controller.flush();
    expect(h.requests).toHaveLength(1);
    expect(h.controller.getStatus().state).toBe('saved');
    await h.controller.flush();
    expect(h.requests).toHaveLength(1);
  });
});

describe('failures', () => {
  it('shows offline, retries with growing delays, and recovers', async () => {
    const h = setup();
    let failures = 2;
    h.respond((request) => {
      if (failures-- > 0) return { kind: 'error', message: 'Network is down', offline: true };
      h.server.draft = { ...h.server.draft, ...request.patch };
      h.server.revision += 1;
      return { kind: 'ok', revision: h.server.revision, draft: h.server.draft };
    });
    h.controller.edit({ ...base, bodyMarkdown: 'work' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.controller.getStatus()).toMatchObject({ state: 'offline', retryInMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.controller.getStatus()).toMatchObject({ state: 'offline', retryInMs: 6000 });
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.controller.getStatus().state).toBe('saved');
    expect(h.requests).toHaveLength(3);
    expect(h.requests.every((r) => r.patch.bodyMarkdown === 'work')).toBe(true);
  });

  it('retryNow does not wait for the timer', async () => {
    const h = setup();
    let down = true;
    h.respond((request) => {
      if (down) return { kind: 'error', message: 'Server error', offline: false };
      h.server.draft = { ...h.server.draft, ...request.patch };
      h.server.revision += 1;
      return { kind: 'ok', revision: h.server.revision, draft: h.server.draft };
    });
    h.controller.edit({ ...base, bodyMarkdown: 'x' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.controller.getStatus().state).toBe('error');
    down = false;
    await h.controller.retryNow();
    expect(h.controller.getStatus().state).toBe('saved');
  });

  it('retries a failed deliberate save as a deliberate save', async () => {
    const h = setup();
    let down = true;
    h.respond((request) => {
      if (down) return { kind: 'error', message: 'down', offline: true };
      h.server.draft = { ...h.server.draft, ...request.patch };
      h.server.revision += 1;
      return { kind: 'ok', revision: h.server.revision, draft: h.server.draft };
    });
    h.controller.edit({ ...base, bodyMarkdown: 'keep this' });
    await h.controller.saveNow();
    down = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.requests.at(-1)?.reason).toBe('manual');
  });

  it('a rejected field is left out of later saves so the rest still saves, until it changes', async () => {
    const h = setup();
    h.respond((request) => {
      if (request.patch.slug === 'taken') return { kind: 'invalid', message: 'Some fields need attention.', fields: { slug: 'Another article of yours already uses that slug.' } };
      h.server.draft = { ...h.server.draft, ...request.patch };
      h.server.revision += 1;
      return { kind: 'ok', revision: h.server.revision, draft: h.server.draft };
    });
    h.controller.edit({ ...base, slug: 'taken', bodyMarkdown: 'body text' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.requests.map((r) => Object.keys(r.patch))).toEqual([['slug', 'bodyMarkdown'], ['bodyMarkdown']]);
    expect(h.controller.getStatus().fieldErrors.slug).toBeTruthy();
    expect(h.server.draft.bodyMarkdown).toBe('body text');
    h.controller.edit({ ...base, slug: 'taken', bodyMarkdown: 'body text more' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(Object.keys(h.requests.at(-1)!.patch)).toEqual(['bodyMarkdown']);
    h.controller.edit({ ...base, slug: 'free-now', bodyMarkdown: 'body text more' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.requests.at(-1)!.patch).toEqual({ slug: 'free-now' });
    expect(h.controller.getStatus().state).toBe('saved');
  });
});

describe('conflicts', () => {
  function conflicted() {
    const h = setup();
    // Another session saved first.
    h.server.draft = { ...base, bodyMarkdown: 'their text', title: 'Their title' };
    h.server.revision = 5;
    h.controller.edit({ ...base, bodyMarkdown: 'my text' });
    return h;
  }

  it('stops at a conflict, keeps my text, and does not keep retrying', async () => {
    const h = conflicted();
    await vi.advanceTimersByTimeAsync(1500);
    const status = h.controller.getStatus();
    expect(status.state).toBe('conflict');
    expect(status.conflict).toMatchObject({ revision: 5, draft: { bodyMarkdown: 'their text' } });
    h.controller.edit({ ...base, bodyMarkdown: 'my text, edited more' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.requests).toHaveLength(1);
    expect(h.server.draft.bodyMarkdown).toBe('their text');
  });

  it('keepMine overwrites with my version against the current revision', async () => {
    const h = conflicted();
    await vi.advanceTimersByTimeAsync(1500);
    await h.controller.keepMine();
    expect(h.requests.at(-1)).toMatchObject({ expectedRevision: 5, reason: 'manual', patch: { bodyMarkdown: 'my text', title: 'Title' } });
    expect(h.server.draft.bodyMarkdown).toBe('my text');
    expect(h.controller.getStatus()).toMatchObject({ state: 'saved', conflict: null });
  });

  it('takeTheirs drops my edits and adopts the other version', async () => {
    const h = conflicted();
    await vi.advanceTimersByTimeAsync(1500);
    const theirs = h.controller.takeTheirs();
    expect(theirs).toMatchObject({ revision: 5, draft: { bodyMarkdown: 'their text' } });
    expect(h.controller.getStatus()).toMatchObject({ state: 'saved', revision: 5 });
    h.controller.edit(theirs!.draft);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.requests).toHaveLength(1);
  });

  it('adopt resets to a server copy, for example after a restore', async () => {
    const h = setup();
    h.controller.edit({ ...base, bodyMarkdown: 'unsaved' });
    h.controller.adopt({ draft: { ...base, bodyMarkdown: 'restored' }, revision: 9 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.requests).toHaveLength(0);
    expect(h.controller.getStatus()).toMatchObject({ state: 'saved', revision: 9 });
  });
});

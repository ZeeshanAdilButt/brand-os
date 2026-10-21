import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.js';
import { createAudit, redactDetail } from '../src/audit.js';
import { openDb } from '../src/db/open.js';
import { createRepos } from '../src/db/repos.js';
import { bufferAlertNotifier } from '../src/notify.js';
import { activeRouteKind, RouteRegistry } from '../src/routes/registry.js';
import type { Health } from '../src/routes/types.js';
import { ConnectionsService } from '../src/services/connections.js';
import { FakeNotifier } from './helpers/fake-notifier.js';
import { FakeRoute } from './helpers/fake-route.js';

const NOW = new Date('2026-10-19T10:00:00.000Z');
const FAKE_KEY = 'not-a-real-key-0123456789abcdef';

/** A Buffer-like route: `lastHealth` serves the cached probe, and `health` must never be called by the gate. */
class CachedRoute extends FakeRoute {
  cached: { health: Health; checkedAt: string } | undefined;
  lastHealth(): { health: Health; checkedAt: string } | undefined {
    return this.cached;
  }
}

function rig(linkedinRoute: 'buffer' | 'assist' = 'buffer') {
  const repos = createRepos(openDb(':memory:'), { now: () => NOW.toISOString() });
  const config: Config = ConfigSchema.parse({ platforms: { linkedin: { route: linkedinRoute } } });
  const devto = new FakeRoute('devto', 'direct');
  const buffer = new CachedRoute('linkedin', 'buffer');
  const assist = new FakeRoute('linkedin', 'assist');
  assist.healthAnswer = { state: 'manual_only' };
  const connect: { account: string; input: Record<string, string> }[] = [];
  Object.assign(devto, {
    connect: (account: string, input: Record<string, string>) => {
      connect.push({ account, input });
      return Promise.resolve<Health>({ state: 'connected', who: '@zee' });
    },
  });
  const routes = new RouteRegistry([devto, buffer, assist]);
  const service = new ConnectionsService({ repos, routes, config: () => config, audit: createAudit(repos), now: () => NOW });
  return { repos, routes, devto, buffer, assist, service, connect };
}

describe('RouteRegistry and activeRouteKind', () => {
  it('holds both LinkedIn routes; config picks the active one (assist until configured)', () => {
    const x = rig();
    expect(x.routes.get('linkedin', 'buffer')).toBe(x.buffer);
    expect(x.routes.get('linkedin', 'assist')).toBe(x.assist);
    expect(activeRouteKind('linkedin', ConfigSchema.parse({ platforms: { linkedin: { route: 'buffer' } } }))).toBe('buffer');
    expect(activeRouteKind('linkedin', ConfigSchema.parse({}))).toBe('assist');
    expect(activeRouteKind('devto', ConfigSchema.parse({}))).toBe('direct');
  });
});

describe('ConnectionsService', () => {
  it('list reports cached health per route without calling any route, and never the input secrets', async () => {
    const x = rig();
    x.buffer.cached = { health: { state: 'connected', who: 'Zee on LinkedIn' }, checkedAt: NOW.toISOString() };
    await x.service.connect('devto', { apiKey: FAKE_KEY });
    x.devto.healthCalls.length = 0;

    const list = x.service.list();
    expect(list).toEqual([
      expect.objectContaining({ platform: 'devto', route: 'direct', active: true, state: 'connected', who: '@zee' }),
      expect.objectContaining({ platform: 'linkedin', route: 'buffer', active: true, state: 'connected', who: 'Zee on LinkedIn' }),
      expect.objectContaining({ platform: 'linkedin', route: 'assist', active: false, state: 'manual_only' }),
    ]);
    expect(x.devto.healthCalls).toEqual([]);
    expect(x.buffer.healthCalls).toEqual([]);
    expect(JSON.stringify(list)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(x.repos.audit.list())).not.toContain(FAKE_KEY);
    expect(x.connect).toEqual([{ account: 'default', input: { apiKey: FAKE_KEY } }]);
  });

  it('a route never checked lists as unchecked', () => {
    const x = rig();
    expect(x.service.list().find((c) => c.platform === 'devto')?.state).toBe('unchecked');
  });

  it('connect refuses a route that cannot be connected', async () => {
    const x = rig('assist');
    await expect(x.service.connect('linkedin', { apiKey: FAKE_KEY })).rejects.toThrow(/cannot be connected/);
  });

  it('gateHealth: Buffer from the cache only (no metered probe), dev.to live, assist healthy', async () => {
    const x = rig();
    expect(await x.service.gateHealth('linkedin', 'default')).toBe(false);
    x.buffer.cached = { health: { state: 'connected' }, checkedAt: NOW.toISOString() };
    expect(await x.service.gateHealth('linkedin', 'default')).toBe(true);
    x.buffer.cached = { health: { state: 'needs_reconnect' }, checkedAt: NOW.toISOString() };
    expect(await x.service.gateHealth('linkedin', 'default')).toBe(false);
    expect(x.buffer.healthCalls).toEqual([]);

    expect(await x.service.gateHealth('devto', 'default')).toBe(true);
    expect(x.devto.healthCalls).toEqual(['default']);
    x.devto.health = () => Promise.reject(new Error('dev.to 500'));
    expect(await x.service.gateHealth('devto', 'default')).toBe(false);

    const y = rig('assist');
    expect(await y.service.gateHealth('linkedin', 'default')).toBe(true);
  });
});

describe('audit and notify helpers', () => {
  it('createAudit redacts every string in detail but keeps hash values', () => {
    const repos = createRepos(openDb(':memory:'), { now: () => NOW.toISOString() });
    const sha = 'c'.repeat(64);
    createAudit(repos)({
      actorChannel: 'test',
      action: 'x',
      hash: sha,
      detail: { message: `Authorization: Bearer ${FAKE_KEY}`, nested: [{ apiKey: FAKE_KEY }], newHash: sha, count: 2 },
    });
    const [row] = repos.audit.list();
    expect(JSON.stringify(row)).not.toContain(FAKE_KEY);
    expect(row?.hash).toBe(sha);
    expect(row?.detail).toMatchObject({ newHash: sha, count: 2 });
    expect(redactDetail(undefined)).toBeUndefined();
  });

  it('bufferAlertNotifier turns a route alert into a toast', () => {
    const notifier = new FakeNotifier();
    bufferAlertNotifier(notifier)({ level: 'critical', title: 'Delete it', message: 'A post may be live', link: 'https://publish.buffer.com' });
    expect(notifier.toasts).toEqual([{ title: 'Delete it', body: 'A post may be live https://publish.buffer.com', level: 'critical' }]);
  });
});

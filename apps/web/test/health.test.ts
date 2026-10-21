import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '../src/app/api/health/route';
import { getHealth } from '../src/server/actions/system';
import { closeDb } from '../src/server/db';
import { MIGRATIONS_DIR, memoryDb, tempDirWithSpace } from './helpers';

const SAVED = { ...process.env };

beforeEach(() => {
  process.env.CPH_MIGRATIONS_DIR = MIGRATIONS_DIR;
});

afterEach(async () => {
  await closeDb();
  process.env = { ...SAVED };
});

describe('getHealth (action layer)', () => {
  it('reports ok for a migrated database', async () => {
    const handle = await memoryDb();
    const health = await getHealth({ env: { MODE: 'local' }, openDb: async () => handle });
    expect(health).toMatchObject({ status: 'ok', mode: 'local', db: { ok: true, driver: 'pglite', schema: 'ready' } });
    expect(health.db.latencyMs).toBeGreaterThanOrEqual(0);
    await handle.close();
  });

  it('reports degraded when the database answers but migrations are pending', async () => {
    const handle = await memoryDb({ migrate: false });
    const health = await getHealth({ env: { MODE: 'local' }, openDb: async () => handle });
    expect(health).toMatchObject({ status: 'degraded', db: { ok: true, schema: 'pending' } });
    await handle.close();
  });

  it('reports error with a safe message when the database cannot be opened', async () => {
    const health = await getHealth({
      env: { MODE: 'hosted', DATABASE_URL: 'postgres://user:secret-value@db.internal/app' },
      openDb: async () => {
        throw new Error('connect ECONNREFUSED postgres://user:secret-value@db.internal/app');
      },
    });
    expect(health.status).toBe('error');
    expect(health.db).toMatchObject({ ok: false, driver: 'postgres', error: 'database could not be opened' });
    expect(JSON.stringify(health)).not.toContain('secret-value');
  });

  it('reports error with the fix when configuration is invalid', async () => {
    const health = await getHealth({ env: { MODE: 'hosted' } });
    expect(health.status).toBe('error');
    expect(health.mode).toBe('unknown');
    expect(health.db.error).toMatch(/DATABASE_URL/);
  });
});

describe('GET /api/health', () => {
  it('returns 200 with the documented shape, backed by a real local database', async () => {
    process.env.MODE = 'local';
    process.env.DATA_DIR = path.join(tempDirWithSpace(), 'route data');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok', mode: 'local', db: { ok: true, driver: 'pglite', schema: 'ready' } });
    expect(typeof body.db.latencyMs).toBe('number');
  });

  it('returns 503 when the app is misconfigured', async () => {
    process.env.MODE = 'hosted';
    delete process.env.DATABASE_URL;
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe('error');
  });
});

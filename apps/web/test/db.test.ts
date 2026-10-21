import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/server/config';
import { scopedAudit } from '../src/server/data/audit';
import { ensureLocalOwner, LOCAL_OWNER_ID } from '../src/server/data/users';
import { createDb, DataDirLockedError, pingDb, type DbHandle } from '../src/server/db/client';
import { migrationStatus, runMigrations } from '../src/server/db/migrate';
import { users } from '../src/server/db/schema';
import { MIGRATIONS_DIR, memoryDb, tempDirWithSpace } from './helpers';

const open: DbHandle[] = [];
async function track(handle: Promise<DbHandle>): Promise<DbHandle> {
  const h = await handle;
  open.push(h);
  return h;
}
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

/** Multi-statement scripts need the raw PGlite client; drizzle's execute() runs one prepared statement. */
async function script(handle: DbHandle, text: string): Promise<void> {
  await (handle.db as unknown as { $client: { exec(sql: string): Promise<unknown> } }).$client.exec(text);
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  return (result as { rows: Record<string, unknown>[] }).rows;
}

/** Message of an error and all its causes (drizzle wraps the driver error in a generic one). */
function errorChain(err: unknown): string {
  const parts: string[] = [];
  for (let e = err; e instanceof Error; e = e.cause) parts.push(e.message);
  return parts.join(' | ');
}

describe('migrations', () => {
  it('apply on a fresh database and create the base tables', async () => {
    const handle = await track(memoryDb({ migrate: false }));
    expect(await migrationStatus(handle, MIGRATIONS_DIR)).toMatchObject({ applied: 0, upToDate: false });

    await runMigrations(handle, MIGRATIONS_DIR);

    const status = await migrationStatus(handle, MIGRATIONS_DIR);
    expect(status.upToDate).toBe(true);
    expect(status.applied).toBe(status.expected);
    const tables = rowsOf(
      await handle.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`),
    ).map((r) => r.table_name);
    expect(tables).toEqual(expect.arrayContaining(['audit_events', 'users']));
  });

  it('are idempotent', async () => {
    const handle = await track(memoryDb());
    await runMigrations(handle, MIGRATIONS_DIR);
    await runMigrations(handle, MIGRATIONS_DIR);
    const status = await migrationStatus(handle, MIGRATIONS_DIR);
    expect(status.applied).toBe(status.expected);
  });
});

describe('local owner', () => {
  it('is created once, with one audit event, however often it is ensured', async () => {
    const handle = await track(memoryDb());
    const first = await ensureLocalOwner(handle.db);
    const second = await ensureLocalOwner(handle.db);
    expect(first.id).toBe(LOCAL_OWNER_ID);
    expect(second.id).toBe(LOCAL_OWNER_ID);
    expect(first.kind).toBe('local_owner');
    expect(await handle.db.select().from(users)).toHaveLength(1);
    const events = await scopedAudit(handle.db, LOCAL_OWNER_ID).list();
    expect(events.map((e) => e.action)).toEqual(['local_owner.created']);
  });
});

describe('tenant scoping in the data-access layer', () => {
  it('never lets one owner read or see another owner’s audit events', async () => {
    const handle = await track(memoryDb());
    const [a, b] = await handle.db
      .insert(users)
      .values([
        { kind: 'member', displayName: 'A', email: 'a@example.test' },
        { kind: 'member', displayName: 'B', email: 'b@example.test' },
      ])
      .returning();
    if (!a || !b) throw new Error('fixture users missing');

    await scopedAudit(handle.db, a.id).record({ actor: 'owner', action: 'a.private' });
    await scopedAudit(handle.db, b.id).record({ actor: 'owner', action: 'b.private' });

    expect((await scopedAudit(handle.db, a.id).list()).map((e) => e.action)).toEqual(['a.private']);
    expect((await scopedAudit(handle.db, b.id).list()).map((e) => e.action)).toEqual(['b.private']);
  });

  it('rejects a malformed owner id instead of widening the query', () => {
    expect(() => scopedAudit({} as never, "x' or '1'='1")).toThrow();
  });

  it('rejects an owner id that does not exist (foreign key)', async () => {
    const handle = await track(memoryDb());
    await expect(
      scopedAudit(handle.db, '11111111-1111-4111-8111-111111111111').record({ actor: 'owner', action: 'x' }),
    ).rejects.toThrow();
  });
});

describe('PGlite capabilities we rely on (recorded in DECISIONS.md)', () => {
  it('supports tsvector full-text search with ranking', async () => {
    const handle = await track(memoryDb({ migrate: false }));
    await script(
      handle,
      `
      create table fts_probe (
        id serial primary key,
        body text not null,
        tsv tsvector generated always as (to_tsvector('english', body)) stored
      );
      create index fts_probe_tsv on fts_probe using gin (tsv);
      insert into fts_probe (body) values ('tuning postgres vacuum for large tables'), ('a note about sourdough');
    `,
    );
    const hits = rowsOf(
      await handle.db.execute(
        sql`select body from fts_probe where tsv @@ websearch_to_tsquery('english', 'vacuum tuning') order by ts_rank(tsv, websearch_to_tsquery('english', 'vacuum tuning')) desc`,
      ),
    );
    expect(hits.map((h) => h.body)).toEqual(['tuning postgres vacuum for large tables']);
  });

  it('enforces row level security for a non-superuser role, and the default superuser bypasses it', async () => {
    const handle = await track(memoryDb({ migrate: false }));
    await script(
      handle,
      `
      create table rls_probe (id serial primary key, owner_id text not null, body text);
      alter table rls_probe enable row level security;
      alter table rls_probe force row level security;
      create policy tenant on rls_probe
        using (owner_id = current_setting('app.owner', true))
        with check (owner_id = current_setting('app.owner', true));
      create role probe_app nologin;
      grant all on rls_probe to probe_app;
      grant usage, select on all sequences in schema public to probe_app;
      insert into rls_probe (owner_id, body) values ('a', 'a row'), ('b', 'b row');
    `,
    );
    // Superuser (what the embedded engine connects as) sees everything: RLS alone is not a boundary here.
    expect(rowsOf(await handle.db.execute(sql`select 1 from rls_probe`))).toHaveLength(2);

    await handle.db.execute(sql`set role probe_app`);
    await handle.db.execute(sql`select set_config('app.owner', 'a', false)`);
    expect(rowsOf(await handle.db.execute(sql`select owner_id from rls_probe`))).toEqual([{ owner_id: 'a' }]);
    const smuggle = await handle.db
      .execute(sql`insert into rls_probe (owner_id, body) values ('b', 'smuggled')`)
      .then(() => null, (err: unknown) => err);
    // Drizzle wraps driver errors; the policy violation is on the cause.
    expect(errorChain(smuggle)).toMatch(/row-level security/);
  });
});

describe('driver switch', () => {
  it('local mode selects embedded PGlite; no env is needed', () => {
    expect(loadConfig({})).toMatchObject({ mode: 'local', driver: 'pglite', dataDir: './.data' });
    expect(loadConfig({ MODE: 'local', DATA_DIR: '/x', DATABASE_URL: 'postgres://ignored' })).toMatchObject({
      driver: 'pglite',
      databaseUrl: undefined,
    });
  });

  it('hosted mode selects Postgres and requires DATABASE_URL', () => {
    expect(() => loadConfig({ MODE: 'hosted' })).toThrow(ConfigError);
    expect(loadConfig({ MODE: 'hosted', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' })).toMatchObject({
      mode: 'hosted',
      driver: 'postgres',
    });
  });

  it('rejects an unknown mode with a helpful message', () => {
    expect(() => loadConfig({ MODE: 'cloud' })).toThrow(/Invalid environment/);
  });

  it('opens the node-postgres driver lazily and reports an unreachable server without throwing', async () => {
    const handle = await track(
      createDb(loadConfig({ MODE: 'hosted', DATABASE_URL: 'postgres://user:not-a-real-password@127.0.0.1:1/db' })),
    );
    expect(handle.driver).toBe('postgres');
    expect(await pingDb(handle)).toEqual({ ok: false, latencyMs: null });
  });

  it('local mode answers a ping', async () => {
    const handle = await track(memoryDb());
    const ping = await pingDb(handle);
    expect(ping.ok).toBe(true);
    expect(ping.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('on-disk PGlite data directory', () => {
  it('works in a path containing a space, persists data, and guards against a second process', async () => {
    const dir = path.join(tempDirWithSpace(), 'data dir');
    const config = loadConfig({ DATA_DIR: dir });

    const first = await track(createDb(config));
    await runMigrations(first, MIGRATIONS_DIR);
    await ensureLocalOwner(first.db);
    expect(fs.existsSync(path.join(dir, 'cph.lock'))).toBe(true);

    // A second open of the same directory must fail loudly, not corrupt data.
    await expect(createDb(config)).rejects.toBeInstanceOf(DataDirLockedError);

    await first.close();
    open.pop();
    expect(fs.existsSync(path.join(dir, 'cph.lock'))).toBe(false);

    const reopened = await track(createDb(config));
    expect(await reopened.db.select().from(users)).toHaveLength(1);
  });

  it('takes over a stale lock left by a process that no longer exists', async () => {
    const dir = path.join(tempDirWithSpace(), 'stale');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cph.lock'), '2147483646'); // not a live pid
    const handle = await track(createDb(loadConfig({ DATA_DIR: dir })));
    expect(await pingDb(handle)).toMatchObject({ ok: true });
  });
});

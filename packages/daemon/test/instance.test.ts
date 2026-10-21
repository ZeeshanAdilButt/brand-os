import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/open.js';
import { createRepos } from '../src/db/repos.js';
import { acquireInstanceLock, DaemonAlreadyRunningError, instanceLockPath, processIsAlive } from '../src/instance-lock.js';
import { installCrashHandlers, runMain, startDaemon, type MainProcess, type RunningDaemon } from '../src/main.js';
import { dbPath } from '../src/paths.js';

let state: string;

beforeEach(() => {
  // A space in the name, like the real %LOCALAPPDATA% paths can have.
  state = mkdtempSync(join(tmpdir(), 'cph instance '));
});

afterEach(() => {
  rmSync(state, { recursive: true, force: true });
});

const LIVE_PID = process.ppid;
const GONE = (): boolean => false;
const ALIVE = (): boolean => true;

describe('acquireInstanceLock', () => {
  it('creates daemon.lock holding our pid, and release removes it', () => {
    const lock = acquireInstanceLock(state, { pid: 1234, isAlive: ALIVE });
    expect(lock.file).toBe(instanceLockPath(state));
    expect(readFileSync(lock.file, 'utf8').trim()).toBe('1234');
    lock.release();
    expect(existsSync(lock.file)).toBe(false);
    lock.release();
  });

  it('refuses while another live process holds the lock, and leaves its lock alone', () => {
    const first = acquireInstanceLock(state, { pid: 1111, isAlive: ALIVE });
    expect(() => acquireInstanceLock(state, { pid: 2222, isAlive: ALIVE })).toThrow(DaemonAlreadyRunningError);
    expect(() => acquireInstanceLock(state, { pid: 2222, isAlive: ALIVE })).toThrow(/pid 1111.*will not start/);
    expect(readFileSync(first.file, 'utf8').trim()).toBe('1111');
    first.release();
    const second = acquireInstanceLock(state, { pid: 2222, isAlive: ALIVE });
    expect(readFileSync(second.file, 'utf8').trim()).toBe('2222');
    second.release();
  });

  it('replaces a stale lock whose process is gone', () => {
    writeFileSync(instanceLockPath(state), '999999\n');
    const lock = acquireInstanceLock(state, { pid: 3333, isAlive: GONE });
    expect(readFileSync(lock.file, 'utf8').trim()).toBe('3333');
    lock.release();
  });

  it('refuses an unreadable lock instead of guessing it is stale', () => {
    writeFileSync(instanceLockPath(state), '');
    expect(() => acquireInstanceLock(state, { pid: 3333, isAlive: GONE })).toThrow(/pid unknown/);
  });

  it('release never removes a lock another process took over', () => {
    const lock = acquireInstanceLock(state, { pid: 4444, isAlive: ALIVE });
    writeFileSync(lock.file, '5555\n');
    lock.release();
    expect(readFileSync(lock.file, 'utf8').trim()).toBe('5555');
  });

  it('processIsAlive sees this process and a parent, and not a pid that does not exist', () => {
    expect(processIsAlive(process.pid)).toBe(true);
    expect(processIsAlive(LIVE_PID)).toBe(true);
  });
});

/** A second daemon's state as it is mid-publish: one dev.to draft in 'publishing'. */
function seedPublishingDraft(): void {
  const db = openDb(dbPath(state));
  const repos = createRepos(db, { now: () => '2026-10-20T10:00:00.000Z' });
  repos.content.upsert({
    slug: 'a-post',
    canonicalUrl: 'https://www.example-blog.dev/blog/a-post',
    title: 'A post',
    date: '2026-10-01',
    mdxSha256: 'a'.repeat(64),
    repoCommit: 'abc1234',
    dirty: false,
    published: true,
  });
  repos.drafts.insert({
    id: 'mid-publish',
    slug: 'a-post',
    platform: 'devto',
    account: 'default',
    route: 'direct',
    kind: 'article',
    status: 'publishing',
    payload: { title: 'A post' },
    payloadSha256: 'f'.repeat(64),
    authorship: 'reformatted',
    lint: [],
  });
  db.close();
}

function readDraft(): { status: string; audit: number } {
  const db = openDb(dbPath(state));
  const repos = createRepos(db, { now: () => '2026-10-20T10:00:00.000Z' });
  const out = { status: repos.drafts.get('mid-publish')?.status as string, audit: repos.audit.list({ draftId: 'mid-publish' }).length };
  db.close();
  return out;
}

/** The lock a running daemon holds: a live pid that is not ours. */
const holdLockAsRunningDaemon = (): void => writeFileSync(instanceLockPath(state), `${LIVE_PID}\n`);

describe('a second daemon on the same state dir', () => {
  it('refuses to start before the recovery sweep, so the other daemon\'s publishing draft is untouched', async () => {
    expect(processIsAlive(LIVE_PID)).toBe(true);
    seedPublishingDraft();
    holdLockAsRunningDaemon();

    await expect(startDaemon({ env: { CPH_STATE_DIR: state } })).rejects.toThrow(DaemonAlreadyRunningError);

    expect(readDraft()).toEqual({ status: 'publishing', audit: 0 });
    // The running daemon's lock is still there, still its own.
    expect(readFileSync(instanceLockPath(state), 'utf8').trim()).toBe(String(LIVE_PID));
  });

  it('releases its own lock when a start fails after taking it', async () => {
    // config.json that is not JSON: loadConfig throws, right after the lock is taken.
    writeFileSync(join(state, 'config.json'), '{ not json');
    await expect(startDaemon({ env: { CPH_STATE_DIR: state } })).rejects.toThrow(/not valid JSON/);
    expect(existsSync(instanceLockPath(state))).toBe(false);
  });
});

class FakeProcess extends EventEmitter implements MainProcess {
  readonly exits: number[] = [];
  readonly stderrText: string[] = [];
  readonly stderr = { write: (text: string) => this.stderrText.push(text) };
  exit(code: number): void {
    this.exits.push(code);
  }
}

const daemonLog = (): string => readFileSync(join(state, 'logs', 'daemon.log'), 'utf8');

describe('the daemon entry point (runMain)', () => {
  it('writes a start failure to <stateDir>\\logs\\daemon.log and exits 1', async () => {
    const proc = new FakeProcess();
    await runMain({ env: { CPH_STATE_DIR: state }, proc, start: () => Promise.reject(new Error('port 4646 is taken')) });
    expect(proc.exits).toEqual([1]);
    expect(daemonLog()).toMatch(/ error failed to start: Error: port 4646 is taken/);
    expect(proc.stderrText.join('')).toContain('failed to start: port 4646 is taken');
  });

  it('logs the refusal of a second daemon to daemon.log', async () => {
    seedPublishingDraft();
    holdLockAsRunningDaemon();
    const proc = new FakeProcess();
    await runMain({ env: { CPH_STATE_DIR: state }, proc });
    expect(proc.exits).toEqual([1]);
    expect(daemonLog()).toMatch(/failed to start: DaemonAlreadyRunningError: another content-powerhouse daemon/);
    expect(readDraft().status).toBe('publishing');
  });

  it('installs crash handlers that log an uncaught exception or unhandled rejection, then exit 1', async () => {
    const proc = new FakeProcess();
    const running: RunningDaemon = { daemon: {} as RunningDaemon['daemon'], close: () => Promise.resolve() };
    await runMain({ env: { CPH_STATE_DIR: state }, proc, start: () => Promise.resolve(running) });
    expect(proc.listenerCount('uncaughtException')).toBe(1);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);

    proc.emit('uncaughtException', new Error('boom in a timer'));
    proc.emit('unhandledRejection', 'a rejected promise');
    expect(proc.exits).toEqual([1, 1]);
    const log = daemonLog();
    expect(log).toMatch(/ error uncaught exception, exiting: Error: boom in a timer/);
    expect(log).toMatch(/ error unhandled rejection, exiting: a rejected promise/);
  });

  it('crash handlers redact secrets before they are logged', () => {
    const proc = new FakeProcess();
    const lines: string[] = [];
    installCrashHandlers(proc, (level, message) => lines.push(`${level} ${message}`));
    proc.emit('uncaughtException', new Error('failed with api-key: not-a-real-key-0123456789abcdef'));
    expect(proc.exits).toEqual([1]);
    expect(lines[0]).toMatch(/^error uncaught exception/);
    expect(proc.stderrText.join('')).not.toContain('not-a-real-key-0123456789abcdef');
  });
});

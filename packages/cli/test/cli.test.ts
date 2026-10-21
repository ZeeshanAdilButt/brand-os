import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonApiError, DaemonUnavailableError } from '@cph/client';
import { MASTER_KEY_NAME } from '@cph/daemon/keystore';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/program.js';
import { cmdLineFor, findOnPath, planSpawn } from '../src/exec.js';
import { fakeDaemon, fixtureSiteRepo, makeRig, tempDir } from './helpers.js';

// Built at run time: shaped like a nonce, not like any provider's key.
const NONCE = `nonce-${'Qz7'.repeat(10)}`;
const LOGIN_URL = `http://127.0.0.1:4646/login?nonce=${NONCE}&next=/approvals`;

const connection = (state: string, platform = 'devto') => ({
  platform,
  route: 'direct',
  account: 'default',
  active: true,
  state,
  who: 'owner',
  nextAction: state === 'needs_reconnect' ? 'Reconnect it: cph connect devto' : undefined,
});

describe('cph dashboard', () => {
  it('opens the login link and never prints the nonce', async () => {
    const loginNonce = vi.fn(async () => ({ nonce: NONCE, expiresAt: '2026-10-20T10:12:00Z', url: LOGIN_URL }));
    const rig = makeRig({ daemon: fakeDaemon({ loginNonce }) });
    const code = await runCli(['dashboard'], rig.ctx);
    expect(code).toBe(0);
    expect(rig.opened).toEqual([LOGIN_URL]);
    expect(rig.text()).not.toContain(NONCE);
    expect(rig.text()).not.toContain('nonce=');
    expect(rig.text()).toContain('Opened the dashboard');
  });

  it('passes the page along and still prints no nonce', async () => {
    const loginNonce = vi.fn(async () => ({ nonce: NONCE, expiresAt: 'x', url: LOGIN_URL }));
    const rig = makeRig({ daemon: fakeDaemon({ loginNonce }) });
    await runCli(['dashboard', 'log'], rig.ctx);
    expect(loginNonce).toHaveBeenCalledWith('log');
    expect(rig.text()).not.toContain(NONCE);
  });

  it('does not repeat the link when the browser cannot be opened', async () => {
    const rig = makeRig({
      daemon: fakeDaemon({ loginNonce: async () => ({ nonce: NONCE, expiresAt: 'x', url: LOGIN_URL }) }),
      open: async (url) => {
        throw new Error(`spawn failed for ${url}`);
      },
    });
    const code = await runCli(['dashboard'], rig.ctx);
    expect(code).toBe(2);
    expect(rig.text()).not.toContain(NONCE);
  });
});

describe('cph status', () => {
  it('exits 1 when a connection needs reconnecting', async () => {
    const rig = makeRig({
      daemon: fakeDaemon({ listConnections: async () => ({ secretsReady: true, connections: [connection('needs_reconnect')] }) }),
    });
    expect(await runCli(['status'], rig.ctx)).toBe(1);
    expect(rig.out.join('\n')).toContain('platform');
    expect(rig.out.join('\n')).toContain('needs_reconnect');
    expect(rig.out.join('\n')).toContain('Reconnect it: cph connect devto');
  });

  it('exits 0 when everything is connected or not set up', async () => {
    const rig = makeRig({
      daemon: fakeDaemon({
        listConnections: async () => ({
          secretsReady: true,
          connections: [connection('connected'), connection('not_configured', 'linkedin'), connection('expiring', 'x')],
        }),
      }),
    });
    expect(await runCli(['status'], rig.ctx)).toBe(0);
  });

  it('exits 1 when the master key is missing', async () => {
    const rig = makeRig({ daemon: fakeDaemon({ listConnections: async () => ({ secretsReady: false, connections: [] }) }) });
    expect(await runCli(['status'], rig.ctx)).toBe(1);
    expect(rig.err.join('\n')).toContain('cph install');
  });

  it('says so when the daemon is down', async () => {
    const rig = makeRig({
      daemon: fakeDaemon({
        listConnections: async () => {
          throw new DaemonUnavailableError('the daemon could not be reached');
        },
      }),
    });
    expect(await runCli(['status'], rig.ctx)).toBe(2);
    expect(rig.err.join('\n')).toContain('not running');
  });

  it('masks a token-shaped string in an error', async () => {
    const leaked = `cph_cli_${'Ab1'.repeat(14)}A`;
    const rig = makeRig({
      daemon: fakeDaemon({
        listConnections: async () => {
          throw new DaemonApiError(500, 'INTERNAL', `boom ${leaked}`);
        },
      }),
    });
    await runCli(['status'], rig.ctx);
    expect(rig.err.join('\n')).not.toContain(leaked);
  });
});

describe('cph connect', () => {
  it('opens the connect card for the platform', async () => {
    const loginNonce = vi.fn(async () => ({ nonce: NONCE, expiresAt: 'x', url: LOGIN_URL }));
    const rig = makeRig({ daemon: fakeDaemon({ loginNonce }) });
    expect(await runCli(['connect', 'devto'], rig.ctx)).toBe(0);
    expect(loginNonce).toHaveBeenCalledWith('connections/devto');
    expect(rig.opened).toHaveLength(1);
  });

  it('refuses an unknown platform', async () => {
    const rig = makeRig();
    expect(await runCli(['connect', 'myspace'], rig.ctx)).toBe(2);
    expect(rig.opened).toEqual([]);
  });

  it('--paste needs a terminal', async () => {
    const rig = makeRig({ isTty: false });
    expect(await runCli(['connect', 'devto', '--paste'], rig.ctx)).toBe(2);
    expect(rig.err.join('\n')).toContain('interactive terminal');
  });

  it('--paste signs in with the nonce, posts the typed key to the card and never prints it', async () => {
    const KEY = 'not-a-real-key-0123456789abcdef';
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.includes('/login')) {
        return new Response(null, { status: 303, headers: { 'set-cookie': 'cph_session=sess123; Path=/; HttpOnly; SameSite=Strict' } });
      }
      if (init?.method === 'POST') return new Response('<p>Connected</p>', { status: 200 });
      return new Response('<form><input type="hidden" name="_csrf" value="csrf456"></form>', { status: 200 });
    }) as typeof fetch;
    const rig = makeRig({
      isTty: true,
      secret: KEY,
      fetchFn,
      daemon: fakeDaemon({ loginNonce: async () => ({ nonce: NONCE, expiresAt: 'x', url: LOGIN_URL }) }),
    });
    expect(await runCli(['connect', 'devto', '--paste'], rig.ctx)).toBe(0);
    const post = seen.find((s) => s.init?.method === 'POST');
    expect(post?.url).toBe('http://127.0.0.1:4646/connections/devto');
    expect(String(post?.init?.body)).toContain('_csrf=csrf456');
    expect(new Headers(post?.init?.headers).get('cookie')).toBe('cph_session=sess123');
    expect(rig.text()).not.toContain(KEY);
    expect(rig.text()).not.toContain(NONCE);
    expect(rig.opened).toEqual([]);
  });
});

describe('cph sync, drafts, log, check', () => {
  it('sync reports counts and exits 1 on per-post errors', async () => {
    const ok = makeRig({
      daemon: fakeDaemon({ sync: async () => ({ upserted: 3, changed: ['a'], invalidatedApprovals: 1, errors: [] }) }),
    });
    expect(await runCli(['sync'], ok.ctx)).toBe(0);
    expect(ok.out.join('\n')).toContain('Synced 3 posts.');
    const bad = makeRig({
      daemon: fakeDaemon({ sync: async () => ({ upserted: 1, changed: [], invalidatedApprovals: 0, errors: [{ slug: 'x', message: 'bad mdx' }] }) }),
    });
    expect(await runCli(['sync'], bad.ctx)).toBe(1);
    expect(bad.err.join('\n')).toContain('x: bad mdx');
  });

  const draft = {
    id: 'd-1',
    slug: 'sample-post',
    platform: 'devto',
    account: 'default',
    route: 'direct',
    kind: 'article',
    status: 'draft',
    authorship: 'reformatted',
    payload: { title: 'T' },
    payloadSha256: 'abc',
    lint: [{ rule: 'title-length', severity: 'warning', message: 'long' }],
  };

  it('drafts lists by default, with filters', async () => {
    const listDrafts = vi.fn(async () => ({ drafts: [draft] }));
    const rig = makeRig({ daemon: fakeDaemon({ listDrafts }) });
    expect(await runCli(['drafts'], rig.ctx)).toBe(0);
    expect(rig.out.join('\n')).toContain('d-1');
    await runCli(['drafts', 'list', '--platform', 'devto', '--status', 'draft'], rig.ctx);
    expect(listDrafts).toHaveBeenLastCalledWith({ platform: 'devto', status: 'draft' });
  });

  it('drafts show prints the draft and its lint', async () => {
    const rig = makeRig({ daemon: fakeDaemon({ getDraft: async () => draft }) });
    expect(await runCli(['drafts', 'show', 'd-1'], rig.ctx)).toBe(0);
    expect(rig.out.join('\n')).toContain('lint warning: title-length');
    expect(rig.out.join('\n')).toContain('"title": "T"');
  });

  it('drafts stage stages privately', async () => {
    const stageDraft = vi.fn(async () => ({ remoteId: '42', previewUrl: 'https://dev.to/preview' }));
    const rig = makeRig({ daemon: fakeDaemon({ stageDraft }) });
    expect(await runCli(['drafts', 'stage', 'd-1'], rig.ctx)).toBe(0);
    expect(stageDraft).toHaveBeenCalledWith('d-1');
    expect(rig.out.join('\n')).toContain('Nothing is public');
  });

  it('log passes --limit', async () => {
    const getLog = vi.fn(async () => ({ entries: [{ id: 1, ts: '2026-10-20T10:00:00Z', actorChannel: 'dashboard', action: 'signed_in' }] }));
    const rig = makeRig({ daemon: fakeDaemon({ getLog }) });
    expect(await runCli(['log', '--limit', '5'], rig.ctx)).toBe(0);
    expect(getLog).toHaveBeenCalledWith({ limit: 5 });
    expect(rig.out.join('\n')).toContain('signed_in');
    expect(await runCli(['log', '--limit', '0'], rig.ctx)).not.toBe(0);
  });

  it('check reports the outcome and exits 1 only while it is still unknown', async () => {
    for (const [outcome, code] of [['published', 0], ['failed', 0], ['unknown', 1]] as const) {
      const rig = makeRig({ daemon: fakeDaemon({ checkDraft: async () => ({ outcome }) }) });
      expect(await runCli(['check', 'd-1'], rig.ctx)).toBe(code);
    }
  });
});

describe('the prompt is closed', () => {
  it('after every command, so the process can exit', async () => {
    const rig = makeRig({ daemon: fakeDaemon({ sync: async () => ({ upserted: 0, changed: [], invalidatedApprovals: 0, errors: [] }) }) });
    await runCli(['sync'], rig.ctx);
    expect(rig.closed.count).toBe(1);
    await runCli(['bogus'], rig.ctx);
    expect(rig.closed.count).toBe(2);
  });
});

describe('cph daemon', () => {
  it('start runs the daemon in this process', async () => {
    const rig = makeRig();
    expect(await runCli(['daemon', 'start'], rig.ctx)).toBe(0);
    expect(rig.ctx.runDaemon).toHaveBeenCalledOnce();
  });

  it('stop only explains; it runs nothing', async () => {
    const rig = makeRig();
    expect(await runCli(['daemon', 'stop'], rig.ctx)).toBe(0);
    expect(rig.execCalls).toEqual([]);
  });

  it('status tells running from not running', async () => {
    const up = makeRig({ daemon: fakeDaemon({ listConnections: async () => ({ secretsReady: true, connections: [] }) }) });
    expect(await runCli(['daemon', 'status'], up.ctx)).toBe(0);
    const down = makeRig({
      daemon: fakeDaemon({
        listConnections: async () => {
          throw new DaemonUnavailableError('no');
        },
      }),
    });
    expect(await runCli(['daemon', 'status'], down.ctx)).toBe(1);
    const refused = makeRig({
      daemon: fakeDaemon({
        listConnections: async () => {
          throw new DaemonApiError(401, 'UNAUTHORIZED', 'no');
        },
      }),
    });
    await runCli(['daemon', 'status'], refused.ctx);
    expect(refused.out.join('\n')).toContain('answer yes to rotating the API tokens');
  });
});

describe('cph doctor', () => {
  const healthyExec = vi.fn(async (file: string, args: readonly string[]) => {
    if (args[0] === '-e') return { stdout: String(args[2]), stderr: '' };
    return { stdout: '10.24.0\n', stderr: '' };
  });

  it('reports the site repo with the number of fixture posts', async () => {
    const rig = makeRig({ siteRepo: fixtureSiteRepo(), exec: healthyExec, seedKeys: { [MASTER_KEY_NAME]: 'x' } });
    const code = await runCli(['doctor'], rig.ctx);
    expect(rig.out).toContain('site repo: OK (3 posts)');
    expect(rig.out).toContain('node: OK (v22.22.2)');
    expect(rig.out).toContain('master key: OK (present)');
    expect(rig.out).toContain('state dir: OK (writable)');
    expect(rig.out).toContain('paths with spaces: OK (round-trip through execFile)');
    expect(rig.out.some((l) => l.startsWith('port 4646: OK'))).toBe(true);
    expect(code).toBe(0);
  });

  it('fails (exit 1) on old node, a missing master key, an empty site repo and a foreign port owner', async () => {
    const rig = makeRig({
      siteRepo: tempDir('cph empty '),
      exec: healthyExec,
      nodeVersion: 'v20.11.0',
      portFree: false,
      daemon: fakeDaemon({
        listConnections: async () => {
          throw new DaemonApiError(401, 'UNAUTHORIZED', 'no');
        },
      }),
    });
    expect(await runCli(['doctor'], rig.ctx)).toBe(1);
    const text = rig.out.join('\n');
    expect(text).toContain('node: FAIL');
    expect(text).toContain('site repo: FAIL');
    expect(text).toContain('master key: FAIL');
    expect(text).toContain('port 4646: FAIL');
  });

  it('accepts the daemon already holding the port', async () => {
    const rig = makeRig({
      siteRepo: fixtureSiteRepo(),
      exec: healthyExec,
      portFree: false,
      seedKeys: { [MASTER_KEY_NAME]: 'x' },
      daemon: fakeDaemon({ listConnections: async () => ({ secretsReady: true, connections: [] }) }),
    });
    expect(await runCli(['doctor'], rig.ctx)).toBe(0);
    expect(rig.out).toContain('port 4646: OK (the daemon is up)');
  });

  // The brief expected 15 posts when it was written; the clone has grown since, so the expected count
  // is taken from the folder itself (an independent read), not hard-coded.
  it.skipIf(process.env['CPH_SITE_REPO'] === undefined)('integration: the real site clone is counted correctly (read only)', async () => {
    const repo = process.env['CPH_SITE_REPO'] as string;
    const expected = readdirSync(join(repo, 'content', 'posts')).filter((n) => n.endsWith('.mdx')).length;
    expect(expected).toBeGreaterThanOrEqual(15);
    const rig = makeRig({ siteRepo: repo, exec: healthyExec });
    await runCli(['doctor'], rig.ctx);
    expect(rig.out).toContain(`site repo: OK (${expected} posts)`);
  });
});

describe('running programs on Windows', () => {
  const env = { PATH: 'C:\\tools;C:\\npm', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const present = new Set(['C:\\npm\\pnpm.cmd', 'C:\\tools\\git.exe']);
  const exists = (p: string): boolean => present.has(p);

  it('finds a command on PATH, preferring .exe', () => {
    expect(findOnPath('git', env, exists)).toBe('C:\\tools\\git.exe');
    expect(findOnPath('pnpm', env, exists)).toBe('C:\\npm\\pnpm.cmd');
    expect(findOnPath('nope', env, exists)).toBeUndefined();
  });

  it('runs an .exe directly and a .cmd shim through cmd.exe with every argument quoted', () => {
    expect(planSpawn('git', ['--version'], env, 'win32', exists)).toEqual({ file: 'C:\\tools\\git.exe', args: ['--version'], verbatim: false });
    const plan = planSpawn('pnpm', ['--filter', '@cph/cli', 'link', '--global'], env, 'win32', exists);
    expect(plan.file).toBe(env.ComSpec);
    expect(plan.verbatim).toBe(true);
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(plan.args[3]).toBe('""C:\\npm\\pnpm.cmd" "--filter" "@cph/cli" "link" "--global""');
  });

  it('leaves a name that is not found alone, so the caller sees ENOENT', () => {
    expect(planSpawn('claude', ['mcp'], env, 'win32', exists)).toEqual({ file: 'claude', args: ['mcp'], verbatim: false });
    expect(planSpawn('anything', ['x'], env, 'linux', exists).file).toBe('anything');
  });

  it('doubles trailing backslashes so they cannot escape the closing quote', () => {
    // Two arguments in, two quoted arguments out; the trailing backslash becomes two.
    expect(cmdLineFor('C:\\npm\\x.cmd', ['C:\\trail\\', 'next'])).toBe('""C:\\npm\\x.cmd" "C:\\trail\\\\" "next""');
    expect(cmdLineFor('C:\\npm\\x.cmd', ['a\\b'])).toBe('""C:\\npm\\x.cmd" "a\\b""');
  });

  it('keeps a path with spaces as one quoted argument and refuses cmd metacharacters', () => {
    expect(cmdLineFor('C:\\npm\\claude.cmd', ['mcp', 'C:\\My Projects\\x y\\index.js'])).toBe('""C:\\npm\\claude.cmd" "mcp" "C:\\My Projects\\x y\\index.js""');
    expect(() => cmdLineFor('C:\\npm\\claude.cmd', ['a & calc'])).toThrow(/metacharacters/);
    expect(() => cmdLineFor('C:\\npm\\claude.cmd', ['say "hi"'])).toThrow(/metacharacters/);
  });
});

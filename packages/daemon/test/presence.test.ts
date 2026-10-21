import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.js';
import { createRepos, type Repos } from '../src/db/repos.js';
import { ClickPresence, WindowsHelloPresence, defaultHelloScriptPath, powershellExePath, type ExecFileFn } from '../src/gate/presence.js';
import { setPublishingEnabled } from '../src/gate/publishing.js';
import { FakePresence } from './helpers/fake-presence.js';
import { copyGateAssets } from '../scripts/copy-assets.mjs';

interface Call {
  file: string;
  args: readonly string[];
  options: { timeout?: number; windowsHide?: boolean; encoding?: string; maxBuffer?: number };
}

type Reply = { stdout?: string; stderr?: string; error?: Error & { code?: number | string; killed?: boolean; signal?: string } };

/** A fake `execFile`: records each call and answers with `reply`. Never starts a process. */
function fakeExecFile(reply: Reply | (() => Reply)): { exec: ExecFileFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFileFn = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const r = typeof reply === 'function' ? reply() : reply;
    queueMicrotask(() => callback(r.error ?? null, r.stdout ?? '', r.stderr ?? ''));
    return undefined;
  };
  return { exec, calls };
}

const json = (availability: string, result: string): string => `${JSON.stringify({ availability, result })}\r\n`;
const PS_TAIL = ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'];
const SCRIPT ='C:\\My Projects\\content-powerhouse\\packages\\daemon\\src\\gate\\hello.ps1';

function verifierWith(reply: Reply | (() => Reply)): { hello: WindowsHelloPresence; calls: Call[] } {
  const { exec, calls } = fakeExecFile(reply);
  return { hello: new WindowsHelloPresence({ execFile: exec, scriptPath: SCRIPT }), calls };
}

describe('WindowsHelloPresence', () => {
  it.each([
    ['Available', 'Verified', 'verified'],
    ['Available', 'Canceled', 'canceled'],
    ['Available', 'DeviceNotPresent', 'unavailable'],
    ['Available', 'NotConfiguredForUser', 'unavailable'],
    ['Available', 'DisabledByPolicy', 'unavailable'],
    ['DeviceNotPresent', 'NotRequested', 'unavailable'],
    ['NotConfiguredForUser', 'NotRequested', 'unavailable'],
    ['Available', 'DeviceBusy', 'error'],
    ['Available', 'RetriesExhausted', 'error'],
    ['Available', 'SomethingNew', 'error'],
    ['Available', 'Error', 'error'],
  ] as const)('availability %s + result %s gives %s', async (availability, result, expected) => {
    const { hello } = verifierWith({ stdout: json(availability, result) });
    expect(await hello.verify('Enable publishing')).toBe(expected);
  });

  it('Verified is not enough without availability Available', async () => {
    const { hello } = verifierWith({ stdout: json('DeviceBusy', 'Verified') });
    expect(await hello.verify('x')).not.toBe('verified');
    const other = verifierWith({ stdout: `${JSON.stringify({ result: 'Verified' })}\n` });
    expect(await other.hello.verify('x')).toBe('error');
  });

  it.each([
    ['empty output', ''],
    ['not JSON', 'Verified'],
    ['garbage', '\u0000\u0001 not json {{{'],
    ['a JSON string', '"Verified"'],
    ['a JSON array', '["Verified"]'],
    ['null', 'null'],
    ['a non-string result', '{"availability":"Available","result":true}'],
    ['lower-case verified', '{"availability":"Available","result":"verified"}'],
    ['two lines, the second one Verified', `${json('Available', 'Canceled')}${json('Available', 'Verified')}`],
    ['noise before the line', `WARNING: something\n${json('Available', 'Verified')}`],
  ])('garbage output (%s) gives error', async (_name, stdout) => {
    const { hello } = verifierWith({ stdout });
    expect(await hello.verify('x')).toBe('error');
  });

  it('exit code 1 gives error, even when stdout says Verified', async () => {
    const error = Object.assign(new Error('Command failed'), { code: 1 });
    const { hello } = verifierWith({ error, stdout: json('Available', 'Verified') });
    expect(await hello.verify('x')).toBe('error');
  });

  it('a timeout (child killed) gives error, even when stdout says Verified', async () => {
    const error = Object.assign(new Error('Command failed: timed out'), { killed: true, signal: 'SIGTERM' });
    const { hello } = verifierWith({ error, stdout: json('Available', 'Verified') });
    expect(await hello.verify('x')).toBe('error');
  });

  it('powershell.exe missing (spawn error) gives error', async () => {
    const error = Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' });
    const { hello } = verifierWith({ error });
    expect(await hello.verify('x')).toBe('error');
  });

  it('an execFile that throws synchronously gives error', async () => {
    const hello = new WindowsHelloPresence({
      scriptPath: SCRIPT,
      execFile: () => {
        throw new Error('boom');
      },
    });
    expect(await hello.verify('x')).toBe('error');
  });

  it('calls Windows PowerShell 5.1 by absolute path (no PATH or cwd lookup), with an args array whose script path contains spaces, and a 120 s timeout', async () => {
    const { hello, calls } = verifierWith({ stdout: json('Available', 'Verified') });
    await hello.verify('Approve: LinkedIn post for prometheus-cardinality-explained');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(powershellExePath());
    expect(calls[0]?.file).toBe(win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', ...PS_TAIL));
    expect(win32.isAbsolute(calls[0]?.file ?? '')).toBe(true);
    expect(calls[0]?.file.toLowerCase().endsWith(win32.join('', ...PS_TAIL).toLowerCase())).toBe(true);
    expect(calls[0]?.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
      '-Prompt',
      'Approve: LinkedIn post for prometheus-cardinality-explained',
    ]);
    expect(Array.isArray(calls[0]?.args)).toBe(true);
    expect(SCRIPT).toContain(' ');
    expect(calls[0]?.options.timeout).toBe(120_000);
  });

  it('passes the prompt as one argument, never through a shell, whatever it contains', async () => {
    const { hello, calls } = verifierWith({ stdout: json('Available', 'Verified') });
    await hello.verify('Approve: X post for a"; calc & echo $env:USERNAME');
    const args = calls[0]?.args ?? [];
    expect(args.at(-2)).toBe('-Prompt');
    expect(args.at(-1)).toBe('Approve: X post for a"; calc & echo $env:USERNAME');
    expect(args).toHaveLength(8);
  });

  it('strips control characters from the prompt and caps its length', async () => {
    const { hello, calls } = verifierWith({ stdout: json('Available', 'Verified') });
    await hello.verify(`a\r\nb\u0000c${'z'.repeat(500)}`);
    const prompt = calls[0]?.args.at(-1) ?? '';
    expect(prompt).not.toMatch(/[\u0000-\u001f]/);
    expect(prompt.length).toBeLessThanOrEqual(200);
    expect(prompt.startsWith('a b c')).toBe(true);
  });

  it('powershellExePath uses SystemRoot, falls back to C:\\Windows, and is never a bare name', () => {
    expect(powershellExePath({ SystemRoot: 'D:\\Win OS' })).toBe(['D:\\Win OS', ...PS_TAIL].join('\\'));
    expect(powershellExePath({})).toBe(['C:\\Windows', ...PS_TAIL].join('\\'));
    expect(powershellExePath({ SystemRoot: '' })).toBe(['C:\\Windows', ...PS_TAIL].join('\\'));
    expect(PS_TAIL).toEqual(['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe']);
  });

  it('spikes/S0-hello/verify.ps1 and gate/hello.ps1 are byte-equal', () => {
    const spike = readFileSync(fileURLToPath(new URL('../../../spikes/S0-hello/verify.ps1', import.meta.url)));
    expect(Buffer.compare(spike, readFileSync(defaultHelloScriptPath()))).toBe(0);
  });

  it('the default script path is hello.ps1 next to the module, and it exists (with a space-safe path)', () => {
    const path = defaultHelloScriptPath();
    expect(path.endsWith('hello.ps1')).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(path).not.toContain('%20');
  });

  it('the shipped hello.ps1 accepts -Prompt, awaits through AsTask and prints one JSON line', () => {
    const text = readFileSync(defaultHelloScriptPath(), 'utf8');
    expect(text).toMatch(/\[string\]\$Prompt/);
    expect(text).toContain('System.WindowsRuntimeSystemExtensions');
    expect(text).toContain('CheckAvailabilityAsync');
    expect(text).toContain('RequestVerificationAsync($Prompt)');
    // ASCII only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
    expect([...text].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
  });
});

describe('copyGateAssets (post-build step)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('copies src/gate/hello.ps1 to dist/gate/, creating the folder, in a path with spaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'cph copy assets '));
    dirs.push(root);
    mkdirSync(join(root, 'src', 'gate'), { recursive: true });
    writeFileSync(join(root, 'src', 'gate', 'hello.ps1'), 'Write-Output "hi"\n');
    copyGateAssets(root);
    expect(readFileSync(join(root, 'dist', 'gate', 'hello.ps1'), 'utf8')).toBe('Write-Output "hi"\n');
  });

  it('throws when the source script is missing (a build must not silently ship without it)', () => {
    const root = mkdtempSync(join(tmpdir(), 'cph copy assets '));
    dirs.push(root);
    expect(() => copyGateAssets(root)).toThrow();
  });
});

describe('setPublishingEnabled', () => {
  let db: Db;
  let repos: Repos;
  let presence: FakePresence;
  const now = (): Date => new Date('2026-10-19T10:00:00.000Z');
  const deps = () => ({ repos, presence, now });

  beforeEach(() => {
    db = openDb(':memory:');
    repos = createRepos(db, { now: () => now().toISOString() });
    presence = new FakePresence('verified');
  });
  afterEach(() => db.close());

  it('defaults to off (the migration seeds "false")', () => {
    expect(repos.settings.get('publishing_enabled')).toBe('false');
  });

  it('turning on with verified presence: ok, setting is "true", prompt "Enable publishing", audited', async () => {
    expect(await setPublishingEnabled(deps(), true)).toEqual({ ok: true });
    expect(repos.settings.get('publishing_enabled')).toBe('true');
    expect(presence.prompts).toEqual(['Enable publishing']);
    const [row] = repos.audit.list({ limit: 1 });
    expect(row).toMatchObject({ action: 'publishing_enabled', actorChannel: 'dashboard_hello' });
  });

  it.each(['canceled', 'unavailable', 'error'] as const)('turning on with presence %s: refused, setting unchanged, audited', async (answer) => {
    presence.set(answer);
    expect(await setPublishingEnabled(deps(), true)).toEqual({ ok: false, code: 'PRESENCE_FAILED' });
    expect(repos.settings.get('publishing_enabled')).toBe('false');
    const [row] = repos.audit.list({ limit: 1 });
    expect(row?.action).toBe('publishing_enable_refused');
    expect(row?.detail).toMatchObject({ code: 'PRESENCE_FAILED', result: answer });
  });

  it('turning on with a presence check that throws: refused, setting unchanged', async () => {
    presence.set(new Error('powershell.exe exited 1'));
    expect(await setPublishingEnabled(deps(), true)).toEqual({ ok: false, code: 'PRESENCE_FAILED' });
    expect(repos.settings.get('publishing_enabled')).toBe('false');
  });

  it('a refused turn-on does not switch off an already enabled setting', async () => {
    repos.settings.set('publishing_enabled', 'true');
    presence.set('canceled');
    expect(await setPublishingEnabled(deps(), true)).toEqual({ ok: false, code: 'PRESENCE_FAILED' });
    expect(repos.settings.get('publishing_enabled')).toBe('true');
  });

  it('turning off never calls presence, even when presence would fail, and is audited', async () => {
    repos.settings.set('publishing_enabled', 'true');
    presence.set(new Error('would fail'));
    expect(await setPublishingEnabled(deps(), false)).toEqual({ ok: true });
    expect(repos.settings.get('publishing_enabled')).toBe('false');
    expect(presence.prompts).toEqual([]);
    const [row] = repos.audit.list({ limit: 1 });
    expect(row).toMatchObject({ action: 'publishing_disabled', actorChannel: 'dashboard_hello' });
  });

  it('turning off when it was never on still writes "false" and works without presence', async () => {
    expect(await setPublishingEnabled(deps(), false)).toEqual({ ok: true });
    expect(repos.settings.get('publishing_enabled')).toBe('false');
    expect(presence.prompts).toEqual([]);
  });
});

describe('ClickPresence', () => {
  it('always answers verified: the dashboard click or the chat prompt is the human action', async () => {
    const click = new ClickPresence();
    expect(await click.verify('Approve LinkedIn via buffer')).toBe('verified');
    expect(await click.verify('')).toBe('verified');
  });

  it('setPublishingEnabled records the channel it is given (dashboard_click in click mode)', async () => {
    const db = openDb(':memory:');
    const repos = createRepos(db, { now: () => '2026-10-20T10:00:00.000Z' });
    const deps = { repos, presence: new ClickPresence(), now: () => new Date('2026-10-20T10:00:00.000Z'), actor: 'dashboard_click' };
    expect(await setPublishingEnabled(deps, true)).toEqual({ ok: true });
    expect(repos.settings.get('publishing_enabled')).toBe('true');
    expect(repos.audit.list({ limit: 1 })[0]).toMatchObject({ action: 'publishing_enabled', actorChannel: 'dashboard_click' });
    expect(await setPublishingEnabled(deps, false)).toEqual({ ok: true });
    expect(repos.audit.list({ limit: 1 })[0]).toMatchObject({ action: 'publishing_disabled', actorChannel: 'dashboard_click' });
    db.close();
  });
});

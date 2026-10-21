import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MASTER_KEY_NAME } from '@cph/daemon/keystore';
import { describe, expect, it } from 'vitest';
import { RESIDUAL_RISK_NOTE } from '../src/commands/install.js';
import { desktopConfigPath, mergeDesktopConfig } from '../src/install/claude-desktop.js';
import { claudeMcpAddArgs, mcpEntryPath } from '../src/install/claude-code.js';
import { buildTaskXml, schtasksCreateArgs, taskXmlPath } from '../src/install/task-scheduler.js';
import { GUARD_MATCHER, guardCommand, mergeUserSettings, userSettingsPath } from '../src/install/user-settings.js';
import { runCli } from '../src/program.js';
import { makeRig, tree, type Rig } from './helpers.js';

const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const seed = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};
const backups = (path: string): string[] => readdirSync(dirname(path)).filter((n) => n.startsWith(`${require_basename(path)}.`) && n.endsWith('.bak'));
function require_basename(path: string): string {
  return path.split(/[\\/]/).pop() as string;
}
const roots = (rig: Rig): string[] => [rig.dirs.stateDir, rig.dirs.homeDir, rig.dirs.appDataDir];

describe('cph install: answering n', () => {
  it('makes no execFile call, writes no file and creates no key when every prompt is answered n', async () => {
    const rig = makeRig({ answers: 'all-no' });
    const before = roots(rig).flatMap(tree);
    const code = await runCli(['install'], rig.ctx);
    expect(code).toBe(0);
    expect(rig.execCalls).toEqual([]);
    expect(rig.recorded.writes).toEqual([]);
    expect(rig.recorded.removes).toEqual([]);
    expect(roots(rig).flatMap(tree)).toEqual(before);
    expect(rig.keys.get(MASTER_KEY_NAME)).toBeNull();
    expect(rig.keys.get('api-token:mcp')).toBeNull();
    expect(rig.questions).toHaveLength(9);
  });

  it('closes the prompt when the command finishes, even when it fails', async () => {
    const rig = makeRig({ answers: 'all-no' });
    await runCli(['install'], rig.ctx);
    expect(rig.closed.count).toBe(1);
    const failing = makeRig({ answers: 'all-no', daemon: undefined });
    failing.ctx.loadConfig = () => {
      throw new Error('config broke');
    };
    expect(await runCli(['install'], failing.ctx)).toBe(2);
    expect(failing.closed.count).toBe(1);
  });

  it('prints every side effect before the first question, and the residual-risk note at the end', async () => {
    const rig = makeRig({ answers: 'all-no' });
    await runCli(['install'], rig.ctx);
    const text = rig.out.join('\n');
    for (const needle of ['Credential Manager', 'config.json', 'schtasks', 'pnpm link --global', 'claude mcp add --scope user', 'claude_desktop_config.json', 'settings.json', 'cph-guard.mjs']) {
      expect(text).toContain(needle);
    }
    expect(text.indexOf('settings.json')).toBeLessThan(text.indexOf('Skipped step 1'));
    expect(text).not.toContain('--filter');
    for (const line of RESIDUAL_RISK_NOTE) expect(rig.out).toContain(line);
    expect(RESIDUAL_RISK_NOTE.join(' ')).toMatch(/Your approval is the real gate/);
    expect(RESIDUAL_RISK_NOTE.join(' ')).toMatch(/permission-bypass/);
  });

  it('asks before each step, so answering y to one step runs only that step', async () => {
    const rig = makeRig({ answers: [false, false, true] });
    await runCli(['install'], rig.ctx);
    expect(rig.recorded.writes).toEqual([join(rig.dirs.stateDir, 'config.json')]);
    expect(rig.execCalls).toEqual([]);
    expect(rig.keys.get(MASTER_KEY_NAME)).toBeNull();
  });
});

describe('cph install: answering y to everything (fakes only)', () => {
  it('creates keys and config, registers the task, links cph, and registers Claude Code', async () => {
    const rig = makeRig({ answers: 'all-yes' });
    const code = await runCli(['install'], rig.ctx);
    expect(code).toBe(0);
    expect(rig.keys.get(MASTER_KEY_NAME)).not.toBeNull();
    expect(rig.keys.get('api-token:mcp')).toMatch(/^cph_mcp_/);
    expect(rig.keys.get('api-token:cli')).toMatch(/^cph_cli_/);
    expect(readJson(join(rig.dirs.stateDir, 'config.json')).daemon.port).toBe(4646);

    const xmlPath = taskXmlPath(rig.dirs.stateDir);
    expect(xmlPath).toContain(' ');
    const schtasks = rig.execCalls.find((c) => c.file === 'schtasks');
    expect(schtasks?.args).toEqual(['/Create', '/TN', 'content-powerhouse daemon', '/XML', xmlPath, '/F']);
    // The path is one array element with spaces and no quote characters of its own.
    expect(schtasks?.args[4]).not.toMatch(/["']/);

    const pnpm = rig.execCalls.find((c) => c.file === 'pnpm');
    // `pnpm --filter @cph/cli link --global` fails (pnpm turns --filter into --recursive, which link
    // rejects), so the link runs inside the cli package itself.
    expect(pnpm?.args).toEqual(['link', '--global']);
    expect(pnpm?.cwd).toBe(join(rig.dirs.repoRoot, 'packages', 'cli'));

    const claude = rig.execCalls.find((c) => c.file === 'claude');
    const mcpEntry = mcpEntryPath(rig.dirs.repoRoot);
    expect(claude?.args).toEqual(['mcp', 'add', '--scope', 'user', 'content-powerhouse', '--', 'node', mcpEntry]);
    expect(claude?.args.filter((a) => a === mcpEntry)).toHaveLength(1);
    expect(mcpEntry).toContain(' ');

    expect(rig.execCalls.map((c) => c.file)).toEqual(['schtasks', 'pnpm', 'claude']);
  });

  it('never prints a token or the master key', async () => {
    const rig = makeRig({ answers: 'all-yes' });
    await runCli(['install'], rig.ctx);
    const text = rig.text();
    expect(text).not.toContain(rig.keys.get('api-token:cli') as string);
    expect(text).not.toContain(rig.keys.get('api-token:mcp') as string);
    expect(text).not.toContain(rig.keys.get(MASTER_KEY_NAME) as string);
  });

  describe('API tokens', () => {
    const validMcp = `cph_mcp_${'Ab1'.repeat(14)}A`;
    const validCli = `cph_cli_${'Cd2'.repeat(14)}C`;
    // step 1 no, step 2 yes, then the answer to the rotate question; everything after is no.
    const tokenStep = (rotate: boolean) => [false, true, rotate];

    it('issues both tokens when they are missing, with no rotate question', async () => {
      const rig = makeRig({ answers: [false, true] });
      await runCli(['install'], rig.ctx);
      expect(rig.keys.get('api-token:mcp')).toMatch(/^cph_mcp_[A-Za-z0-9_-]{43}$/);
      expect(rig.keys.get('api-token:cli')).toMatch(/^cph_cli_[A-Za-z0-9_-]{43}$/);
      expect(rig.questions.some((q) => q.includes('Rotate'))).toBe(false);
    });

    it('asks before rotating valid tokens, and n leaves them unchanged', async () => {
      const rig = makeRig({ answers: tokenStep(false), seedKeys: { 'api-token:mcp': validMcp, 'api-token:cli': validCli } });
      await runCli(['install'], rig.ctx);
      expect(rig.questions.filter((q) => q.includes('Rotate the mcp and cli API tokens? [y/N]'))).toHaveLength(1);
      expect(rig.keys.get('api-token:mcp')).toBe(validMcp);
      expect(rig.keys.get('api-token:cli')).toBe(validCli);
    });

    it('rotates both tokens on y and tells you to restart Claude', async () => {
      const rig = makeRig({ answers: tokenStep(true), seedKeys: { 'api-token:mcp': validMcp, 'api-token:cli': validCli } });
      await runCli(['install'], rig.ctx);
      expect(rig.keys.get('api-token:mcp')).not.toBe(validMcp);
      expect(rig.keys.get('api-token:cli')).not.toBe(validCli);
      expect(rig.keys.get('api-token:mcp')).toMatch(/^cph_mcp_/);
      expect(rig.out.join('\n')).toMatch(/Restart Claude Code and Claude Desktop/);
    });

    it('treats a malformed or wrong-scope entry as missing and issues a new token without asking', async () => {
      const rig = makeRig({ answers: [false, true], seedKeys: { 'api-token:mcp': 'garbage', 'api-token:cli': validMcp } });
      await runCli(['install'], rig.ctx);
      expect(rig.keys.get('api-token:mcp')).toMatch(/^cph_mcp_[A-Za-z0-9_-]{43}$/);
      expect(rig.keys.get('api-token:cli')).toMatch(/^cph_cli_[A-Za-z0-9_-]{43}$/);
      expect(rig.questions.some((q) => q.includes('Rotate'))).toBe(false);
    });

    it('leaves the master key alone on a second run', async () => {
      const rig = makeRig({ answers: [true], seedKeys: { [MASTER_KEY_NAME]: Buffer.alloc(32, 7).toString('base64') } });
      await runCli(['install'], rig.ctx);
      expect(rig.keys.get(MASTER_KEY_NAME)).toBe(Buffer.alloc(32, 7).toString('base64'));
    });
  });

  it('does not overwrite an existing config.json', async () => {
    const rig = makeRig({ answers: 'all-yes' });
    seed(join(rig.dirs.stateDir, 'config.json'), '{"daemon":{"port":4700}}');
    await runCli(['install'], rig.ctx);
    expect(readFileSync(join(rig.dirs.stateDir, 'config.json'), 'utf8')).toBe('{"daemon":{"port":4700}}');
  });

  it('writes a Task Scheduler file schtasks can read: UTF-16 with a BOM, logon trigger, no second instance', async () => {
    const rig = makeRig({ answers: 'all-yes' });
    await runCli(['install'], rig.ctx);
    const bytes = readFileSync(taskXmlPath(rig.dirs.stateDir));
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    const xml = bytes.subarray(2).toString('utf16le');
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toMatch(/<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>\s*<\/RestartOnFailure>/);
    // Inside <Settings>, where the Task Scheduler schema expects it.
    expect(xml.indexOf('<RestartOnFailure>')).toBeGreaterThan(xml.indexOf('<Settings>'));
    expect(xml.indexOf('<RestartOnFailure>')).toBeLessThan(xml.indexOf('</Settings>'));
    expect(xml).toContain('<Command>conhost.exe</Command>');
    expect(xml).toContain(`<Arguments>--headless "${process.execPath}" "${join(rig.dirs.repoRoot, 'packages', 'daemon', 'dist', 'main.js')}"</Arguments>`);
    expect(xml).toContain('<UserId>TESTBOX\\tester</UserId>');
  });

  it('skips schtasks, without failing, when the task file was not written', async () => {
    const rig = makeRig({ answers: [false, false, false, false, true] });
    const code = await runCli(['install'], rig.ctx);
    expect(code).toBe(0);
    expect(rig.execCalls).toEqual([]);
    expect(rig.out.join('\n')).toContain('Skipped: the task file');
  });

  it('prints the claude command instead when claude is not on PATH', async () => {
    const rig = makeRig({
      answers: 'all-yes',
      exec: async (file) => {
        if (file === 'claude') throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
        return { stdout: '', stderr: '' };
      },
    });
    const code = await runCli(['install'], rig.ctx);
    expect(code).toBe(0);
    expect(rig.out.join('\n')).toContain(`claude mcp add --scope user content-powerhouse -- node "${mcpEntryPath(rig.dirs.repoRoot)}"`);
  });

  it('reports a failed step, carries on with the rest and exits 1', async () => {
    const rig = makeRig({
      answers: 'all-yes',
      exec: async (file) => {
        if (file === 'schtasks') throw new Error('ERROR: Access is denied.');
        return { stdout: '', stderr: '' };
      },
    });
    const code = await runCli(['install'], rig.ctx);
    expect(code).toBe(1);
    expect(rig.err.join('\n')).toContain('Step 5 failed');
    expect(rig.execCalls.map((c) => c.file)).toEqual(['schtasks', 'pnpm', 'claude']);
    expect(readJson(desktopConfigPath(rig.dirs.appDataDir)).mcpServers['content-powerhouse']).toBeDefined();
  });
});

describe('Claude Desktop config merge', () => {
  const mcpEntry = (rig: Rig): string => mcpEntryPath(rig.dirs.repoRoot);

  it('creates the file when it is missing', async () => {
    const rig = makeRig({ answers: [false, false, false, false, false, false, false, true] });
    await runCli(['install'], rig.ctx);
    expect(readJson(desktopConfigPath(rig.dirs.appDataDir))).toEqual({
      mcpServers: { 'content-powerhouse': { command: 'node', args: [mcpEntry(rig)] } },
    });
    expect(backups(desktopConfigPath(rig.dirs.appDataDir))).toEqual([]);
  });

  it('tells you to quit Claude Desktop before the merge and to check the entry after restarting', async () => {
    const rig = makeRig({ answers: [false, false, false, false, false, false, false, true] });
    await runCli(['install'], rig.ctx);
    const text = rig.out.join('\n');
    const quit = text.indexOf('Quit Claude Desktop fully');
    expect(quit).toBeGreaterThan(-1);
    // Printed in the plan, before the first question is asked.
    expect(quit).toBeLessThan(text.indexOf('Skipped step 1'));
    expect(text).toMatch(/Start Claude Desktop again, then check that content-powerhouse is still listed/);
  });

  it('keeps unrelated keys and servers, writes a .bak, and is idempotent', async () => {
    const rig = makeRig({ answers: [false, false, false, false, false, false, false, true] });
    const path = desktopConfigPath(rig.dirs.appDataDir);
    const original = { theme: 'dark', mcpServers: { other: { command: 'npx', args: ['-y', 'other-server'] } } };
    seed(path, original);
    await runCli(['install'], rig.ctx);
    const merged = readJson(path);
    expect(merged.theme).toBe('dark');
    expect(merged.mcpServers.other).toEqual(original.mcpServers.other);
    expect(merged.mcpServers['content-powerhouse']).toEqual({ command: 'node', args: [mcpEntry(rig)] });
    const bak = backups(path);
    expect(bak).toHaveLength(1);
    expect(bak[0]).toContain('2026-10-20T10-11-12Z');
    expect(readJson(join(dirname(path), bak[0] as string))).toEqual(original);

    // Again: one entry, no second backup, file byte-identical.
    const afterFirst = readFileSync(path, 'utf8');
    await runCli(['install'], rig.ctx);
    expect(readFileSync(path, 'utf8')).toBe(afterFirst);
    expect(Object.keys(readJson(path).mcpServers).sort()).toEqual(['content-powerhouse', 'other']);
    expect(backups(path)).toHaveLength(1);
  });

  it('updates a stale entry in place and refuses to touch a file that is not JSON', async () => {
    expect(
      mergeDesktopConfig({ mcpServers: { 'content-powerhouse': { command: 'node', args: ['old.js'] } } }, 'new.js'),
    ).toEqual({ next: { mcpServers: { 'content-powerhouse': { command: 'node', args: ['new.js'] } } }, changed: true });

    const rig = makeRig({ answers: [false, false, false, false, false, false, false, true] });
    const path = desktopConfigPath(rig.dirs.appDataDir);
    seed(path, '{ not json');
    const code = await runCli(['install'], rig.ctx);
    expect(code).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
    expect(backups(path)).toEqual([]);
    expect(rig.err.join('\n')).toContain('not valid JSON');
  });
});

describe('user-scope Claude settings merge', () => {
  const answersFor9 = [false, false, false, false, false, false, false, false, true];

  it('keeps existing allow rules, ask rules and hooks, and adds ours', async () => {
    const rig = makeRig({ answers: answersFor9 });
    const path = userSettingsPath(rig.dirs.homeDir);
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(git status)', 'Read(*)'], ask: ['Bash(git push:*)'], deny: ['Read(.env)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node other-hook.js' }] }],
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node fmt.js' }] }],
      },
    };
    seed(path, original);
    await runCli(['install'], rig.ctx);
    const s = readJson(path);
    expect(s.model).toBe('opus');
    expect(s.permissions.allow).toEqual(original.permissions.allow);
    expect(s.permissions.deny).toEqual(original.permissions.deny);
    expect(s.permissions.ask).toEqual(['Bash(git push:*)', 'mcp__content-powerhouse__publish', 'mcp__content-powerhouse__schedule']);
    expect(s.hooks.PostToolUse).toEqual(original.hooks.PostToolUse);
    expect(s.hooks.PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]);
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse[1]).toEqual({
      matcher: GUARD_MATCHER,
      hooks: [{ type: 'command', command: `node "${join(rig.dirs.repoRoot, 'packages', 'cli', 'hooks', 'cph-guard.mjs')}"` }],
    });
    expect(GUARD_MATCHER).toContain('mcp__claude-in-chrome__');
    expect(GUARD_MATCHER).toContain('Bash');
    expect(GUARD_MATCHER).toContain('PowerShell');
    expect(GUARD_MATCHER.split('|')).toEqual(expect.arrayContaining(['mcp__terminal__.*', 'Monitor']));
    // The matcher is a regex over the tool name: the new shell-like tools must match it.
    for (const tool of ['Monitor', 'mcp__terminal__run_in_terminal', 'mcp__terminal__read_terminal']) {
      expect(new RegExp(`^(?:${GUARD_MATCHER})$`).test(tool), tool).toBe(true);
    }
    expect(readJson(join(dirname(path), backups(path)[0] as string))).toEqual(original);
  });

  it('is idempotent: a second run changes nothing and adds no backup', async () => {
    const rig = makeRig({ answers: answersFor9 });
    const path = userSettingsPath(rig.dirs.homeDir);
    seed(path, { permissions: { allow: ['Read(*)'] } });
    await runCli(['install'], rig.ctx);
    const first = readFileSync(path, 'utf8');
    await runCli(['install'], rig.ctx);
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(readJson(path).hooks.PreToolUse).toHaveLength(1);
    expect(readJson(path).permissions.ask).toHaveLength(2);
    expect(backups(path)).toHaveLength(1);
  });

  it('creates the file when missing, with no backup', async () => {
    const rig = makeRig({ answers: answersFor9 });
    await runCli(['install'], rig.ctx);
    const path = userSettingsPath(rig.dirs.homeDir);
    expect(readJson(path).hooks.PreToolUse).toHaveLength(1);
    expect(backups(path)).toEqual([]);
  });

  it('skips the ask rules when claude.askOnPublish is false, but still adds the hook', async () => {
    const rig = makeRig({ answers: answersFor9, config: { askOnPublish: false } });
    await runCli(['install'], rig.ctx);
    const s = readJson(userSettingsPath(rig.dirs.homeDir));
    expect(s.permissions).toBeUndefined();
    expect(s.hooks.PreToolUse).toHaveLength(1);
  });

  it('moves the hook when the repo moved, without duplicating it or dropping a sibling hook', () => {
    const old = { hooks: { PreToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: 'node "C:\\old\\cph-guard.mjs"' }, { type: 'command', command: 'node mine.js' }] }] } };
    const { next, changed } = mergeUserSettings(old, { guardCommand: guardCommand('C:\\new'), askOnPublish: false });
    expect(changed).toBe(true);
    const pre = (next['hooks'] as any).PreToolUse;
    expect(pre).toHaveLength(1);
    expect(pre[0].hooks.map((h: any) => h.command)).toEqual([guardCommand('C:\\new'), 'node mine.js']);
    expect(pre[0].matcher).toBe(GUARD_MATCHER);
  });

  it('leaves a settings file that is not valid JSON exactly as it was', async () => {
    const rig = makeRig({ answers: answersFor9 });
    const path = userSettingsPath(rig.dirs.homeDir);
    seed(path, '// comment\n{}');
    expect(await runCli(['install'], rig.ctx)).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe('// comment\n{}');
  });
});

describe('install helpers', () => {
  it('builds the claude and schtasks argument arrays with paths as single elements', () => {
    expect(claudeMcpAddArgs('C:\\My Projects\\x\\index.js').at(-1)).toBe('C:\\My Projects\\x\\index.js');
    expect(schtasksCreateArgs('C:\\a b\\t.xml')).toContain('C:\\a b\\t.xml');
  });

  it('escapes XML special characters in the launch arguments', () => {
    const xml = buildTaskXml({ nodePath: 'C:\\a & b\\node.exe', daemonMain: 'C:\\<x>\\main.js' });
    expect(xml).toContain('C:\\a &amp; b\\node.exe');
    expect(xml).toContain('C:\\&lt;x&gt;\\main.js');
  });

  it('contains no em dash anywhere in what install prints', async () => {
    const rig = makeRig({ answers: 'all-no' });
    await runCli(['install'], rig.ctx);
    expect(rig.text()).not.toContain(String.fromCharCode(0x2014));
  });
});

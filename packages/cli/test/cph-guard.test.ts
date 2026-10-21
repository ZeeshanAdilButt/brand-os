import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error the hook is plain JavaScript with no declaration file
import { evaluate } from '../hooks/cph-guard.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'cph-guard.mjs');
const ENV = { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' };

const chrome = (tool: string, input: unknown) => ({ tool_name: `mcp__claude-in-chrome__${tool}`, tool_input: input });
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
const powershell = (command: string) => ({ tool_name: 'PowerShell', tool_input: { command } });

function runHook(stdin: string) {
  const r = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr, stdout: r.stdout };
}

describe('cph-guard decisions', () => {
  it('blocks claude-in-chrome on the dashboard port', () => {
    for (const url of ['http://127.0.0.1:4646/approvals', 'http://localhost:4646/', 'localhost:4646/approvals/1', 'http://[::1]:4646/']) {
      expect(evaluate(chrome('navigate', { url }), ENV).block, url).toBe(true);
    }
    expect(evaluate({ tool_name: 'mcp__claude-in-chrome__computer', tool_input: { action: 'type', text: 'http://127.0.0.1:4646/approvals' } }, ENV).block).toBe(true);
    expect(evaluate({ tool_name: 'mcp__computer-use__type', tool_input: { text: 'localhost:4646' } }, ENV).block).toBe(true);
  });

  it('blocks every spelling of the loopback host on port 4646, through each browser tool', () => {
    const urls = ['http://127.1:4646/approvals', 'http://2130706433:4646', 'http://0x7f000001:4646/', 'http://0177.0.0.1:4646/', 'http://dashboard.local:4646/'];
    for (const tool of ['mcp__claude-in-chrome__navigate', 'mcp__Claude_Browser__navigate', 'mcp__computer-use__type']) {
      for (const url of urls) {
        expect(evaluate({ tool_name: tool, tool_input: { url } }, ENV).block, `${tool} ${url}`).toBe(true);
      }
      expect(evaluate({ tool_name: tool, tool_input: { url: 'http://127.1:3000/' } }, ENV).block, tool).toBe(false);
      expect(evaluate({ tool_name: tool, tool_input: { url: 'https://example.com:46461/' } }, ENV).block, tool).toBe(false);
    }
  });

  it('blocks the dashboard port written with leading zeros', () => {
    for (const url of ['http://127.0.0.1:04646/approvals', 'http://localhost:004646/', 'localhost:0004646']) {
      expect(evaluate(chrome('navigate', { url }), ENV).block, url).toBe(true);
    }
    expect(evaluate(chrome('navigate', { url: 'http://localhost:046460/' }), ENV).block).toBe(false);
    expect(evaluate(chrome('navigate', { url: 'http://localhost:14646/' }), ENV).block).toBe(false);
  });

  it('allows other browsing', () => {
    expect(evaluate(chrome('navigate', { url: 'https://dev.to' }), ENV).block).toBe(false);
    expect(evaluate(chrome('navigate', { url: 'http://127.0.0.1:3000/' }), ENV).block).toBe(false);
    expect(evaluate(chrome('navigate', { url: 'http://localhost:46460/' }), ENV).block).toBe(false);
  });

  it('blocks a Bash command that reaches for the content-powerhouse keyring or master key', () => {
    const command = `node -e "const {Entry}=require('@napi-rs/keyring'); console.log(new Entry('content-powerhouse','master-key').getPassword())"`;
    const verdict = evaluate(bash(command), ENV);
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain('cph-guard');
  });

  it('blocks the other shapes the brief lists', () => {
    const blocked = [
      'cmdkey /list | findstr content-powerhouse',
      'Get-StoredCredential -Target content-powerhouse # Credential Manager',
      'type %LOCALAPPDATA%\\content-powerhouse\\config.json',
      'sqlite3 "C:\\Users\\tester\\AppData\\Local\\content-powerhouse\\cph.db" "select * from credentials"',
      'cat $env:LOCALAPPDATA/content-powerhouse/cph.db',
      'echo content-powerhouse api-token',
    ];
    for (const command of blocked) {
      expect(evaluate(bash(command), ENV).block, command).toBe(true);
      expect(evaluate(powershell(command), ENV).block, command).toBe(true);
    }
  });

  it('treats Monitor and the terminal MCP tools as shells', () => {
    const command = 'cmdkey /list | findstr content-powerhouse';
    for (const tool of ['Monitor', 'mcp__terminal__run_in_terminal', 'mcp__terminal__open_terminal_tab']) {
      expect(evaluate({ tool_name: tool, tool_input: { command } }, ENV).block, tool).toBe(true);
      expect(evaluate({ tool_name: tool, tool_input: { command: 'pnpm test' } }, ENV).block, tool).toBe(false);
    }
    // A terminal tool whose input has no `command` field is still checked, as JSON.
    expect(evaluate({ tool_name: 'mcp__terminal__run_in_terminal', tool_input: { text: 'type %LOCALAPPDATA%\content-powerhouse\cph.db' } }, ENV).block).toBe(true);
  });

  it('blocks the real state folder even when the command never says "content-powerhouse" in words', () => {
    expect(evaluate(bash('dir C:\\Users\\tester\\AppData\\Local\\content-powerhouse'), ENV).block).toBe(true);
    expect(evaluate(bash('ls /d/state'), { CPH_STATE_DIR: 'D:\\state' }).block).toBe(false);
    expect(evaluate(bash('ls D:/State/logs'), { CPH_STATE_DIR: 'D:\\state' }).block).toBe(true);
  });

  it('allows ordinary commands, including ones inside the repo folder', () => {
    for (const command of ['git status', 'pnpm test', 'cd "C:\\My Projects\\content-powerhouse" && pnpm build', 'cmdkey /list', 'node -e "console.log(1)"']) {
      expect(evaluate(bash(command), ENV).block, command).toBe(false);
    }
  });

  it('ignores tools it was not written for', () => {
    expect(evaluate({ tool_name: 'Read', tool_input: { file_path: 'C:\\x\\content-powerhouse\\master-key' } }, ENV).block).toBe(false);
    expect(evaluate(null, ENV).block).toBe(false);
    expect(evaluate({}, ENV).block).toBe(false);
  });
});

describe('cph-guard as a process (the way Claude Code runs it)', () => {
  it('exits 2 with the reason on stderr for the dashboard', () => {
    const r = runHook(JSON.stringify({ hook_event_name: 'PreToolUse', ...chrome('navigate', { url: 'http://127.0.0.1:4646/approvals' }) }));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cph-guard');
    expect(r.stderr).toContain('dashboard');
  });

  it('exits 2 for the keyring command', () => {
    const r = runHook(JSON.stringify(bash(`node -e "require('@napi-rs/keyring') // content-powerhouse master-key"`)));
    expect(r.code).toBe(2);
  });

  it('exits 0 for git status and for a dev.to navigation', () => {
    expect(runHook(JSON.stringify(bash('git status'))).code).toBe(0);
    expect(runHook(JSON.stringify(chrome('navigate', { url: 'https://dev.to' }))).code).toBe(0);
  });

  it('fails open on input that is not JSON, and says so on stderr', () => {
    const r = runHook('this is not json');
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('allowing the call');
    expect(runHook('').code).toBe(0);
  });

  it('writes nothing to stdout (Claude Code would parse it)', () => {
    expect(runHook(JSON.stringify(bash('git status'))).stdout).toBe('');
  });
});

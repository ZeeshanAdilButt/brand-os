#!/usr/bin/env node
// cph-guard: a user-scope Claude Code PreToolUse hook installed by `cph install`.
//
// Claude Code writes one JSON object to stdin ({ tool_name, tool_input, ... }). Exit code 2 blocks
// the tool call and shows stderr to Claude; exit 0 lets it through. This file has no dependencies
// so it runs from anywhere with a bare `node`.
//
// What it blocks:
//   - claude-in-chrome / computer-use input that mentions the daemon's dashboard
//     (127.0.0.1:4646 or localhost:4646), so Claude cannot drive the approvals page;
//   - Bash / PowerShell / Monitor / terminal-MCP commands that mention content-powerhouse together with its keyring entries,
//     tokens or master key, or its state folder (including the cph.db database).
//
// This is a speed bump, not a wall: Claude runs as the same Windows user and a determined or
// confused model can get round text matching. Windows Hello in the daemon is the real gate.
//
// It fails open on input it cannot parse (exit 0, a note on stderr) so a bug here never bricks Claude.

import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Any `:4646` that is not the start of a longer port, with leading zeros allowed (`:04646` is the
// same port to a browser). Not tied to a host spelling, so 127.1, a decimal or hex IP and other
// loopback forms are caught too.
const DASHBOARD = /:0*4646(?![0-9])/;
const BROWSER_TOOL = /^mcp__(?:claude-in-chrome|computer-use|Claude_Browser)__/;
// Every tool that runs a command line: the built-in shells, Monitor (it runs a command and watches its
// output) and the terminal MCP (it types into the user's own terminal tabs).
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
const SHELL_TOOL_PREFIX = /^mcp__terminal__/;
const PRODUCT = /content-powerhouse/i;
const SENSITIVE = /keyring|Credential|cmdkey|api-token|master-key|cph\.db/i;
const STATE_DIR_HINT = /LOCALAPPDATA|AppData[\\/]+Local|CPH_STATE_DIR/i;

function normalise(text) {
  return text.replace(/\\/g, '/').toLowerCase();
}

/** The state folder this machine would use, spelled with forward slashes and lower case. */
function stateDirNeedle(env) {
  const override = env.CPH_STATE_DIR;
  if (override) return normalise(override);
  if (env.LOCALAPPDATA) return normalise(join(env.LOCALAPPDATA, 'content-powerhouse'));
  return undefined;
}

/**
 * Decides one tool call. Returns `{ block: false }` or `{ block: true, reason }`.
 * @param {unknown} input the parsed hook JSON
 * @param {Record<string, string | undefined>} env
 */
export function evaluate(input, env = process.env) {
  if (typeof input !== 'object' || input === null) return { block: false };
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  const toolInput = input.tool_input ?? {};

  if (BROWSER_TOOL.test(toolName)) {
    if (DASHBOARD.test(JSON.stringify(toolInput))) {
      return {
        block: true,
        reason:
          'cph-guard: the content-powerhouse dashboard (port 4646) is not for Claude to drive. ' +
          'Ask the owner to open it himself with `cph dashboard`; approvals need his Windows Hello.',
      };
    }
    return { block: false };
  }

  if (SHELL_TOOLS.has(toolName) || SHELL_TOOL_PREFIX.test(toolName)) {
    const command = typeof toolInput.command === 'string' ? toolInput.command : JSON.stringify(toolInput);
    const needle = stateDirNeedle(env);
    const touchesStateDir = STATE_DIR_HINT.test(command) || (needle !== undefined && normalise(command).includes(needle));
    const blocked =
      (PRODUCT.test(command) && (SENSITIVE.test(command) || touchesStateDir)) ||
      (needle !== undefined && normalise(command).includes(needle));
    if (blocked) {
      return {
        block: true,
        reason:
          'cph-guard: this command touches content-powerhouse secrets or its state folder ' +
          '(keyring entries, API tokens, the master key, cph.db). Claude must not read them. ' +
          'Use the content-powerhouse MCP tools, or ask the owner to run it.',
      };
    }
  }
  return { block: false };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main() {
  let input;
  try {
    input = JSON.parse((await readStdin()).replace(/^﻿/, ''));
  } catch (error) {
    process.stderr.write(`cph-guard: could not read the hook input, allowing the call (${error.message})\n`);
    return 0;
  }
  const verdict = evaluate(input);
  if (verdict.block) {
    process.stderr.write(`${verdict.reason}\n`);
    return 2;
  }
  return 0;
}

function sameFile(a, b) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const x = real(a);
  const y = real(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

if (process.argv[1] && sameFile(fileURLToPath(import.meta.url), process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`cph-guard: unexpected error, allowing the call (${error.message})\n`);
      process.exit(0);
    },
  );
}

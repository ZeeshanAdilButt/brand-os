import { join } from 'node:path';
import type { ExecFileFn } from '../context.js';

export const MCP_SERVER_NAME = 'content-powerhouse';

export function mcpEntryPath(repoRoot: string): string {
  return join(repoRoot, 'packages', 'mcp', 'dist', 'index.js');
}

/** The `claude` arguments; the entry path is one element even when it has spaces. */
export function claudeMcpAddArgs(mcpEntry: string): string[] {
  return ['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '--', 'node', mcpEntry];
}

/** The same command as a line a person can paste. */
export function claudeMcpAddCommandLine(mcpEntry: string): string {
  return `claude mcp add --scope user ${MCP_SERVER_NAME} -- node "${mcpEntry}"`;
}

export type ClaudeCodeResult =
  | { status: 'registered' }
  | { status: 'already-registered' }
  | { status: 'claude-missing'; command: string };

/**
 * Registers the stdio MCP server with Claude Code at user scope, so it works from any folder.
 * When `claude` is not on PATH nothing is registered and the command is returned to be printed.
 */
export async function registerClaudeCode(execFile: ExecFileFn, mcpEntry: string): Promise<ClaudeCodeResult> {
  try {
    await execFile('claude', claudeMcpAddArgs(mcpEntry));
    return { status: 'registered' };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === 'ENOENT') return { status: 'claude-missing', command: claudeMcpAddCommandLine(mcpEntry) };
    if (/already exists/i.test(`${e.stderr ?? ''} ${e.stdout ?? ''} ${e.message}`)) return { status: 'already-registered' };
    throw error;
  }
}

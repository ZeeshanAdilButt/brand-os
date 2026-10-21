import { join } from 'node:path';
import type { FileOps } from '../context.js';
import { ConfigFileError, isObject, mergeJsonFile, type JsonObject, type MergeOutcome } from './json-merge.js';
import { MCP_SERVER_NAME } from './claude-code.js';

export function desktopConfigPath(appDataDir: string): string {
  return join(appDataDir, 'Claude', 'claude_desktop_config.json');
}

export interface DesktopServerEntry {
  command: string;
  args: string[];
}

export function desktopServerEntry(mcpEntry: string): DesktopServerEntry {
  return { command: 'node', args: [mcpEntry] };
}

/** Pure merge: sets `mcpServers["content-powerhouse"]` and touches nothing else. */
export function mergeDesktopConfig(current: JsonObject, mcpEntry: string): { next: JsonObject; changed: boolean } {
  const servers = current['mcpServers'];
  if (servers !== undefined && !isObject(servers)) {
    throw new ConfigFileError('mcpServers in claude_desktop_config.json is not an object; fix it, then run install again');
  }
  const entry = desktopServerEntry(mcpEntry);
  if (servers !== undefined && JSON.stringify(servers[MCP_SERVER_NAME]) === JSON.stringify(entry)) {
    return { next: current, changed: false };
  }
  return { next: { ...current, mcpServers: { ...(servers ?? {}), [MCP_SERVER_NAME]: entry } }, changed: true };
}

export function registerClaudeDesktop(files: FileOps, appDataDir: string, mcpEntry: string, now: Date): MergeOutcome {
  return mergeJsonFile(files, desktopConfigPath(appDataDir), now, (current) => mergeDesktopConfig(current, mcpEntry));
}

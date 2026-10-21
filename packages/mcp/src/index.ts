#!/usr/bin/env node
/**
 * Stdio MCP server for content-powerhouse (T0.20): a thin facade over the daemon's loopback API.
 * `createMcpServer` is the testable core; the code at the bottom runs only when this file is the
 * process entry point. Nothing may write to stdout except the MCP transport.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DaemonApiError, DaemonClient, type DaemonApi } from '@cph/client';
import { WindowsKeyStore, type KeyStore } from '@cph/daemon/keystore';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { NOT_SET_UP_TEXT, registerTools } from './tools.js';

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:4646';
/** Keyring entry (service `content-powerhouse`) holding the mcp-scope API token. */
export const MCP_TOKEN_ENTRY = 'api-token:mcp';

const INSTRUCTIONS =
  'content-powerhouse turns posts from example-blog.dev into drafts for each platform. ' +
  'You can draft, stage private drafts and ask for approval, but only the owner can approve: in the dashboard, or at the prompt approve_in_chat shows him in Claude Code (call it only when he asks you to). ' +
  'Never ask the user for keys in chat: use connect_platform. Never claim something was posted unless get_approval_status says published.';

export function createMcpServer({ client }: { client: DaemonApi }): McpServer {
  const server = new McpServer({ name: 'content-powerhouse', version: '0.0.0' }, { instructions: INSTRUCTIONS });
  registerTools(server, client);
  registerPrompts(server, client);
  registerResources(server, client);
  return server;
}

/** A client whose every call answers "not set up": used when the mcp token cannot be read. */
function notSetUpClient(): DaemonApi {
  const fail = () => Promise.reject(new DaemonApiError(503, 'NOT_CONFIGURED', NOT_SET_UP_TEXT));
  return new Proxy({} as DaemonApi, { get: () => fail });
}

/**
 * Builds the daemon client from the mcp token in the keystore. A missing token (or an unreadable
 * keystore) gives a client that answers every call with the "run `cph install`" error, so the
 * server still starts and Claude sees a useful message instead of a dead connection.
 */
export function createDaemonClient(
  keystore: () => KeyStore,
  options: { baseUrl?: string; fetchFn?: typeof fetch } = {},
): DaemonApi {
  let token: string | null = null;
  try {
    token = keystore().get(MCP_TOKEN_ENTRY);
  } catch {
    token = null;
  }
  if (token === null || token === '') return notSetUpClient();
  return new DaemonClient({
    baseUrl: options.baseUrl ?? DEFAULT_DAEMON_URL,
    token,
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
  });
}

export async function main(): Promise<void> {
  const server = createMcpServer({ client: createDaemonClient(() => new WindowsKeyStore()) });
  await server.connect(new StdioServerTransport());
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1 === '') return false;
  const a = realPath(fileURLToPath(moduleUrl));
  const b = realPath(argv1);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`cph-mcp failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exit(1);
  });
}

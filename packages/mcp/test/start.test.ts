import { MemoryKeyStore } from '@cph/daemon/keystore';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createDaemonClient, createMcpServer, isEntryPoint, MCP_TOKEN_ENTRY } from '../src/index.js';

const TOKEN = `cph_mcp_${'Zq8'.repeat(14)}Zq`;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function callTool(client: ReturnType<typeof createDaemonClient>, name: string, args: Record<string, unknown> = {}) {
  const server = createMcpServer({ client });
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), mcp.connect(a)]);
  closers.push(() => mcp.close());
  const result = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: result.isError === true, text: result.content.map((c) => c.text).join('\n') };
}

describe('createDaemonClient', () => {
  it('reads api-token:mcp from the keystore and sends it as the bearer token', async () => {
    const keys = new MemoryKeyStore();
    keys.set(MCP_TOKEN_ENTRY, TOKEN);
    let seen: Headers | undefined;
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response(JSON.stringify({ content: [] }), { status: 200 });
    }) as typeof fetch;
    const client = createDaemonClient(() => keys, { fetchFn });
    const { isError } = await callTool(client, 'list_content');
    expect(isError).toBe(false);
    expect(seen?.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('answers every tool with the install hint when there is no token', async () => {
    const client = createDaemonClient(() => new MemoryKeyStore());
    const { isError, text } = await callTool(client, 'list_content');
    expect(isError).toBe(true);
    expect(text).toBe("content-powerhouse isn't set up yet: run `cph install`");
  });

  it('treats an unreadable keystore like a missing token', async () => {
    const client = createDaemonClient(() => {
      throw new Error('keyring unavailable');
    });
    const { isError, text } = await callTool(client, 'sync_content');
    expect(isError).toBe(true);
    expect(text).toContain('cph install');
  });

  it('says the daemon is not running when the connection is refused, without leaking the token', async () => {
    const keys = new MemoryKeyStore();
    keys.set(MCP_TOKEN_ENTRY, TOKEN);
    const fetchFn = (async () => {
      throw Object.assign(new TypeError(`fetch failed Bearer ${TOKEN}`), { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch;
    const client = createDaemonClient(() => keys, { fetchFn });
    const { isError, text } = await callTool(client, 'list_connections');
    expect(isError).toBe(true);
    expect(text).toBe('Daemon not running: run `cph daemon start`');
  });
});

describe('isEntryPoint', () => {
  it('is false when imported (argv1 is another file) and when argv1 is missing', () => {
    expect(isEntryPoint(import.meta.url, undefined)).toBe(false);
    expect(isEntryPoint(import.meta.url, '')).toBe(false);
    expect(isEntryPoint(import.meta.url, 'C:\\somewhere\\else.js')).toBe(false);
  });
});

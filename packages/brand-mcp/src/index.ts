#!/usr/bin/env node
/**
 * Entry point of the Brand OS MCP server (stdio). Configuration comes from the environment so nothing
 * secret sits in a command line or a committed file:
 *
 *   BRAND_OS_CREDENTIAL  a credential from Settings > Agent access (required)
 *   BRAND_OS_URL         where the app runs (default http://127.0.0.1:3100)
 *
 * `--url <address>` is accepted for the address. A credential argument (`--credential`) is accepted for
 * quick tests only: command lines are visible to other programs, so prefer the environment variable.
 * Nothing may write to stdout except the MCP transport.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBrandApi } from './api.js';
import { createBrandServer, createUnconfiguredServer } from './server.js';

export const DEFAULT_URL = 'http://127.0.0.1:3100';

export interface Settings {
  baseUrl: string;
  credential: string | null;
}

/** Read settings from arguments and environment. Arguments win. */
export function readSettings(argv: readonly string[], env: Record<string, string | undefined>): Settings {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    if (at !== -1) return argv[at + 1];
    const joined = argv.find((a) => a.startsWith(`${name}=`));
    return joined ? joined.slice(name.length + 1) : undefined;
  };
  const credential = (flag('--credential') ?? env.BRAND_OS_CREDENTIAL ?? '').trim();
  const baseUrl = (flag('--url') ?? env.BRAND_OS_URL ?? DEFAULT_URL).trim() || DEFAULT_URL;
  return { baseUrl, credential: credential === '' ? null : credential };
}

export function buildServer(settings: Settings, fetchFn?: typeof fetch): McpServer {
  if (!settings.credential) return createUnconfiguredServer();
  return createBrandServer({
    api: createBrandApi({ baseUrl: settings.baseUrl, credential: settings.credential, ...(fetchFn ? { fetchFn } : {}) }),
    credential: settings.credential,
  });
}

export async function main(): Promise<void> {
  const server = buildServer(readSettings(process.argv.slice(2), process.env));
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
    process.stderr.write(`brand-os MCP server failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exit(1);
  });
}

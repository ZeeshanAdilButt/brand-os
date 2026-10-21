import { ANTHROPIC_BASE_URL } from '../../lib/ai';
import type { AppConfig } from '../config';
import type { AppContext } from '../context';
import type { AiProvider } from '../db/schema';
import type { Resolver } from '../import/url';
import { anthropicAdapter } from './adapters/anthropic';
import { openAiCompatible } from './adapters/openai-compatible';
import { AdapterError, type ModelAdapter } from './adapters/types';
import { decryptKey, masterKey, SecretUnavailableError } from './crypto';
import { createSafeFetch } from './safe-fetch';

/**
 * What the AI code needs from its surroundings, in one object so tests can replace the network, the clock
 * and the sleep between retries without touching globals.
 */
export interface AiEnv {
  config: AppConfig;
  /** Replaces the network for every provider call. Production leaves it out. */
  fetchFn?: typeof fetch | undefined;
  /** Name lookup for the hosted address check. */
  resolve?: Resolver | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
  /** How long one model call may take before the task fails. Defaults to two minutes. */
  taskTimeoutMs?: number | undefined;
}

export const DEFAULT_TASK_TIMEOUT_MS = 120_000;

export function aiEnvFrom(ctx: Pick<AppContext, 'config'>, overrides: Partial<Omit<AiEnv, 'config'>> = {}): AiEnv {
  return { config: ctx.config, ...overrides };
}

/** What stops a provider from running, in words, or null when it can run. */
export function notReadyReason(row: Pick<AiProvider, 'kind' | 'enabled' | 'model' | 'baseUrl' | 'encryptedKey' | 'protocol'>): string | null {
  if (row.kind === 'local_cli_agent') return 'This provider type is not built yet.';
  if (!row.enabled) return 'Turned off.';
  if (row.kind === 'claude_code_handoff') return null;
  if (!row.model?.trim()) return 'Choose a model.';
  if (row.protocol !== 'anthropic' && !row.baseUrl) return 'Enter the server address.';
  if (row.kind === 'api_key' && !row.encryptedKey) return 'Add the API key.';
  return null;
}

/** Whether this provider makes model calls itself (the hand-off does not: its tasks wait for Claude Code). */
export function executesTasks(kind: AiProvider['kind']): boolean {
  return kind === 'local' || kind === 'api_key';
}

/** The key of a provider row in plain text, or undefined when it has none. Throws if it cannot be read. */
export function plainKey(env: AiEnv, row: Pick<AiProvider, 'id' | 'ownerId' | 'encryptedKey'>): string | undefined {
  if (!row.encryptedKey) return undefined;
  return decryptKey(row.encryptedKey, masterKey(env.config), row.ownerId, row.id);
}

/** Build the adapter for a provider row. Throws AdapterError('misconfigured') when it is not usable. */
export function adapterFor(env: AiEnv, row: AiProvider): ModelAdapter {
  const reason = notReadyReason(row);
  if (reason || !row.model) throw new AdapterError('misconfigured', reason ?? 'Choose a model.');
  let apiKey: string | undefined;
  try {
    apiKey = plainKey(env, row);
  } catch (err) {
    if (err instanceof SecretUnavailableError) throw new AdapterError('misconfigured', err.message);
    throw err;
  }
  if (row.protocol === 'anthropic') {
    return anthropicAdapter({
      baseUrl: ANTHROPIC_BASE_URL,
      model: row.model,
      apiKey,
      workspaceId: row.workspaceId ?? undefined,
      fetchFn: env.fetchFn,
    });
  }
  const hosted = env.config.mode === 'hosted';
  return openAiCompatible({
    baseUrl: row.baseUrl ?? '',
    model: row.model,
    apiKey,
    fetchFn: env.fetchFn ?? (hosted ? createSafeFetch({ resolve: env.resolve }) : undefined),
  });
}

import type { PlatformId } from '../../lib/publishing';
import type { AppConfig } from '../config';
import type { AppContext } from '../context';
import { decryptKey, masterKey, SecretUnavailableError } from '../ai/crypto';
import type { PlatformConnection } from '../db/schema';
import { DEVTO_DEFAULT_BASE, devtoAdapter } from './adapters/devto';
import { HASHNODE_DEFAULT_BASE, hashnodeAdapter } from './adapters/hashnode';
import type { AdapterContext, PlatformAdapter } from './adapters/types';
import { PLATFORM_TIMEOUT_MS } from './http';

export const ADAPTERS: Record<PlatformId, PlatformAdapter> = { devto: devtoAdapter, hashnode: hashnodeAdapter };

export function adapterFor(platform: PlatformId): PlatformAdapter {
  return ADAPTERS[platform];
}

/**
 * What publishing code needs from its surroundings, in one object so tests can replace the network, the
 * clock and the pause between staging retries without touching globals.
 */
export interface PublishEnv {
  config: AppConfig;
  /** Replaces the network for every platform call. Production leaves it out. */
  fetchFn?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  timeoutMs?: number | undefined;
  /** The process environment, read only for the test-only address override below. */
  processEnv?: Record<string, string | undefined> | undefined;
}

export function publishEnvFrom(ctx: Pick<AppContext, 'config'>, overrides: Partial<Omit<PublishEnv, 'config'>> = {}): PublishEnv {
  return { config: ctx.config, ...overrides };
}

const DEFAULT_BASES: Record<PlatformId, string> = { devto: DEVTO_DEFAULT_BASE, hashnode: HASHNODE_DEFAULT_BASE };
const TEST_URL_VARS: Record<PlatformId, string> = { devto: 'CPH_TEST_DEVTO_URL', hashnode: 'CPH_TEST_HASHNODE_URL' };

/** The flag that switches the address override on. Without it every override is ignored. */
export const TEST_URLS_FLAG = 'CPH_ALLOW_TEST_PLATFORM_URLS';

/**
 * Where a platform lives. The real address is a constant. An override exists only so the built app can be
 * pointed at a fake server on this machine during testing: it is honored only when the explicit test flag is
 * set to `1` AND the address is plain http(s) on a loopback host, so it can never redirect a real key anywhere
 * else.
 */
export function baseUrlFor(env: Pick<PublishEnv, 'processEnv'>, platform: PlatformId): string {
  const vars = env.processEnv ?? process.env;
  const override = vars[TEST_URL_VARS[platform]];
  if (vars[TEST_URLS_FLAG] === '1' && override) {
    try {
      const url = new URL(override);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        const text = url.toString();
        return platform === 'hashnode' ? text.replace(/\/?$/, '/') : text.replace(/\/+$/, '');
      }
    } catch {
      /* ignore a malformed override */
    }
  }
  return DEFAULT_BASES[platform];
}

export class KeyUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyUnreadableError';
  }
}

/** The key of a connection row in plain text. Throws KeyUnreadableError with a message that says what to do. */
export function plainSecret(env: PublishEnv, row: Pick<PlatformConnection, 'id' | 'ownerId' | 'encryptedKey'>): string {
  try {
    return decryptKey(row.encryptedKey, masterKey(env.config), row.ownerId, row.id);
  } catch (err) {
    if (err instanceof SecretUnavailableError) throw new KeyUnreadableError(err.message);
    throw err;
  }
}

/** Everything an adapter call needs, with the key decrypted for this call only. */
export function contextFor(env: PublishEnv, row: PlatformConnection, secret: string = plainSecret(env, row)): { adapter: PlatformAdapter; ctx: AdapterContext } {
  return contextWith(env, row.platform, row.config, secret);
}

/** The same for a key that is not saved yet (checked before it is stored). */
export function contextWith(env: PublishEnv, platform: PlatformId, config: PlatformConnection['config'], secret: string): { adapter: PlatformAdapter; ctx: AdapterContext } {
  return {
    adapter: adapterFor(platform),
    ctx: {
      secret,
      config,
      fetch: env.fetchFn ?? fetch,
      now: env.now ?? (() => new Date()),
      baseUrl: baseUrlFor(env, platform),
      timeoutMs: env.timeoutMs ?? PLATFORM_TIMEOUT_MS,
    },
  };
}

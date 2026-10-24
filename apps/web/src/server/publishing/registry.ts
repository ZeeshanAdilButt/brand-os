import { PLATFORM_IDS, isPlatformId, isPublishable } from '../../lib/catalog';
import type { PlatformId } from '../../lib/publishing';
import type { AppConfig } from '../config';
import type { UrlImportDeps } from '../import/url';
import type { AppContext } from '../context';
import { decryptKey, masterKey, SecretUnavailableError } from '../ai/crypto';
import { unwrapSecret } from '../connect/bundle';
import type { PlatformConnection } from '../db/schema';
import { contentAdapter } from './adapters/content';
import { DEVTO_DEFAULT_BASE, devtoAdapter } from './adapters/devto';
import { GITHUB_DEFAULT_BASE, githubSiteAdapter } from './adapters/github-site';
import { HASHNODE_DEFAULT_BASE, hashnodeAdapter } from './adapters/hashnode';
import type { AdapterContext, PlatformAdapter } from './adapters/types';
import { PLATFORM_TIMEOUT_MS } from './http';

/**
 * Every destination has an adapter. The three with a connector (DEV.to, Hashnode, the personal site) can stage and
 * publish; the rest adapt and check content only, and refuse every call that would reach the platform.
 */
export const ADAPTERS: Record<PlatformId, PlatformAdapter> = Object.fromEntries(
  PLATFORM_IDS.map((id) => [id, id === 'devto' ? devtoAdapter : id === 'hashnode' ? hashnodeAdapter : id === 'site' ? githubSiteAdapter : contentAdapter(id)]),
) as Record<PlatformId, PlatformAdapter>;

export function adapterFor(platform: PlatformId): PlatformAdapter {
  return ADAPTERS[platform];
}

export { isPublishable };

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
  /** Name lookup and the one-hop fetch for the canonical page check. Tests inject fakes; production uses the real ones. */
  canonical?: UrlImportDeps | undefined;
  /** The process environment, read only for the test-only address override below. */
  processEnv?: Record<string, string | undefined> | undefined;
}

export function publishEnvFrom(ctx: Pick<AppContext, 'config'>, overrides: Partial<Omit<PublishEnv, 'config'>> = {}): PublishEnv {
  return { config: ctx.config, ...overrides };
}

const DEFAULT_BASES: Partial<Record<PlatformId, string>> = { devto: DEVTO_DEFAULT_BASE, hashnode: HASHNODE_DEFAULT_BASE, site: GITHUB_DEFAULT_BASE };
const TEST_URL_VARS: Partial<Record<PlatformId, string>> = { devto: 'CPH_TEST_DEVTO_URL', hashnode: 'CPH_TEST_HASHNODE_URL', site: 'CPH_TEST_GITHUB_URL' };

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
  const name = TEST_URL_VARS[platform];
  const override = name ? vars[name] : undefined;
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
  return DEFAULT_BASES[platform] ?? '';
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
    return unwrapSecret(decryptKey(row.encryptedKey, masterKey(env.config), row.ownerId, row.id));
  } catch (err) {
    if (err instanceof SecretUnavailableError) throw new KeyUnreadableError(err.message);
    throw err;
  }
}

/** Everything an adapter call needs, with the key decrypted for this call only. */
export function contextFor(env: PublishEnv, row: PlatformConnection, secret: string = plainSecret(env, row), site?: AdapterContext['site']): { adapter: PlatformAdapter; ctx: AdapterContext } {
  if (!isPlatformId(row.platform)) throw new KeyUnreadableError('This connection is not one that publishes.');
  return contextWith(env, row.platform, row.config, secret, site);
}

/** The same for a key that is not saved yet (checked before it is stored). */
export function contextWith(env: PublishEnv, platform: PlatformId, config: PlatformConnection['config'], secret: string, site?: AdapterContext['site']): { adapter: PlatformAdapter; ctx: AdapterContext } {
  return {
    adapter: adapterFor(platform),
    ctx: {
      secret,
      config,
      fetch: env.fetchFn ?? fetch,
      now: env.now ?? (() => new Date()),
      baseUrl: baseUrlFor(env, platform),
      timeoutMs: env.timeoutMs ?? PLATFORM_TIMEOUT_MS,
      ...(site ? { site } : {}),
    },
  };
}

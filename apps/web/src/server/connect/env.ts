import { RateLimiter } from '../agent/rate-limit';
import type { AppConfig } from '../config';
import type { ConnectorDefinition } from '../../lib/connectors';
import { PLATFORM_TIMEOUT_MS } from '../publishing/http';

/**
 * What connection code needs from its surroundings, in one object so tests replace the network, the clock and the
 * limits without touching globals. Production passes only the config.
 */
export interface ConnectEnv {
  config: AppConfig;
  /** Replaces the network for every platform call (tests). */
  fetchFn?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
  timeoutMs?: number | undefined;
  /** The process environment, read only for the host's own OAuth app credentials and the test address override. */
  processEnv?: Record<string, string | undefined> | undefined;
  /** Replaces the limiters (tests). */
  limits?: ConnectLimits | undefined;
  /** Random bytes (tests make state and verifiers predictable). */
  random?: ((size: number) => Buffer) | undefined;
  /** The pause between waits on a renewal lease (tests make it instant). */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface ConnectLimits {
  /** Starting a sign-in or saving credentials, per owner and platform. */
  attempt: RateLimiter;
  /** Test and validate calls, per owner and platform. */
  validate: RateLimiter;
  /** Callback requests per owner. */
  callback: RateLimiter;
}

export function defaultLimits(): ConnectLimits {
  return {
    attempt: new RateLimiter(10, 60_000),
    validate: new RateLimiter(12, 60_000),
    callback: new RateLimiter(20, 60_000),
  };
}

let shared: ConnectLimits | null = null;
export function limitsFor(env: ConnectEnv): ConnectLimits {
  if (env.limits) return env.limits;
  shared ??= defaultLimits();
  return shared;
}

export const sleepOf = (env: ConnectEnv): ((ms: number) => Promise<void>) => env.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
export const nowOf = (env: ConnectEnv): Date => (env.now ?? (() => new Date()))();
export const timeoutOf = (env: ConnectEnv): number => env.timeoutMs ?? PLATFORM_TIMEOUT_MS;

/** The flag that switches the address override on. Without it every override is ignored. */
export const TEST_URLS_FLAG = 'CPH_ALLOW_TEST_PLATFORM_URLS';

/**
 * Replace the origin of a platform address with a fake server on this machine, for testing only. It is honored only
 * when CPH_ALLOW_TEST_PLATFORM_URLS=1 AND CPH_TEST_CONNECT_<ID> is plain http(s) on a loopback host, so it can never
 * send a real token anywhere else. The path of the address is kept.
 */
export function endpointUrl(env: Pick<ConnectEnv, 'processEnv'>, def: Pick<ConnectorDefinition, 'id'>, url: string): string {
  const vars = env.processEnv ?? process.env;
  const override = vars[`CPH_TEST_CONNECT_${def.id.toUpperCase()}`];
  if (vars[TEST_URLS_FLAG] === '1' && override) {
    try {
      const base = new URL(override);
      if ((base.protocol === 'http:' || base.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
        const target = new URL(url);
        return `${base.origin}${target.pathname}${target.search}`;
      }
    } catch {
      /* ignore a malformed override */
    }
  }
  return url;
}

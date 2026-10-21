import { redactSecrets } from '../ai/redact';
import { PlatformError } from './errors';

/** Every platform request gives up after this long. A publish that times out is `unknown`, never retried. */
export const PLATFORM_TIMEOUT_MS = 30_000;
/** When a platform says "wait" without saying how long. */
export const DEFAULT_RETRY_AFTER_MS = 30_000;

export interface HttpResult {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

export interface RequestOptions {
  fetch: typeof fetch;
  timeoutMs: number;
  /** Strings that must never appear in an error: the key itself. */
  secrets: readonly string[];
  now: () => Date;
}

/** Seconds or an HTTP date, as milliseconds to wait. Anything else is undefined. */
export function parseRetryAfter(value: string | null | undefined, now: Date): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  if (!/[A-Za-z]/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now.getTime());
}

/** The text a person can read for a wait: "about 30 seconds", "about 2 minutes". */
export function waitText(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return `about ${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function clean(text: string, secrets: readonly string[], max = 400): string {
  return redactSecrets(text, secrets).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * One HTTP request with the rules every platform call follows: a timeout, `redirect: 'error'` so a key
 * header is never replayed to another host, and every failure turned into a PlatformError whose text has
 * had the key removed. A non-2xx answer is returned, not thrown; use `failureFor` to classify it.
 */
export async function send(options: RequestOptions, url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<HttpResult> {
  try {
    const res = await options.fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, headers: res.headers, text };
  } catch (err) {
    throw wireFailure(err, options);
  }
}

function wireFailure(err: unknown, options: RequestOptions): PlatformError {
  const name = err instanceof Error ? err.name : '';
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new PlatformError('timeout', `The platform did not answer within ${Math.round(options.timeoutMs / 1000)} seconds.`);
  }
  if (/redirect/i.test(`${message} ${cause}`)) {
    return new PlatformError('redirect', 'The platform answered with a redirect, which is refused so the key is never sent to another address.');
  }
  return new PlatformError('network', clean(`Could not reach the platform (${cause || message}).`, options.secrets));
}

/** Pull the platform's own explanation out of an error body. Handles plain text, {error}, {errors}, {message}. */
export function explanationFrom(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let body: unknown;
  try {
    body = JSON.parse(trimmed);
  } catch {
    return /^<(!doctype|html)/i.test(trimmed) ? null : trimmed;
  }
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['error', 'message', 'errors']) {
    const value = record[key];
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) parts.push(...value.filter((v): v is string => typeof v === 'string'));
    else if (value && typeof value === 'object') {
      for (const [field, v] of Object.entries(value as Record<string, unknown>)) {
        parts.push(`${field}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
      }
    }
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

/** Classify a non-2xx answer. `name` is the platform's display name for the message. */
export function failureFor(name: string, res: HttpResult, options: RequestOptions): PlatformError {
  const detail = explanationFrom(res.text);
  const cleaned = detail ? clean(detail, options.secrets) : null;
  const common = { httpStatus: res.status, detail: cleaned };
  if (res.status === 401 || res.status === 403) {
    return new PlatformError('auth', `${name} did not accept the key.`, common);
  }
  if (res.status === 404) return new PlatformError('not_found', `${name} could not find that item.`, common);
  if (res.status === 429) {
    const wait = parseRetryAfter(res.headers.get('retry-after'), options.now()) ?? DEFAULT_RETRY_AFTER_MS;
    return new PlatformError('rate_limit', `${name} is rate limiting requests. Wait ${waitText(wait)} and try again.`, { ...common, retryAfterMs: wait });
  }
  if (res.status === 408) return new PlatformError('timeout', `${name} timed out.`, common);
  if (res.status >= 500) return new PlatformError('server', `${name} had a problem on its side (HTTP ${res.status}).`, common);
  if (res.status >= 400) {
    return new PlatformError('validation', cleaned ? `${name} refused the request: ${cleaned}` : `${name} refused the request (HTTP ${res.status}).`, common);
  }
  return new PlatformError('protocol', `${name} answered with an unexpected status (HTTP ${res.status}).`, common);
}

export function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

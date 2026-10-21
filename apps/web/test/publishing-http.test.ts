import { describe, expect, it } from 'vitest';
import { PlatformError } from '../src/server/publishing/errors';
import { clean, explanationFrom, failureFor, parseRetryAfter, send, waitText, type RequestOptions } from '../src/server/publishing/http';

const KEY = ['fake', 'key', '0123456789abcdef'].join('-');
const NOW = new Date('2026-10-21T12:00:00Z');

function options(fetchFn: typeof fetch, extra: Partial<RequestOptions> = {}): RequestOptions {
  return { fetch: fetchFn, timeoutMs: 1000, secrets: [KEY], now: () => NOW, ...extra };
}

describe('Retry-After', () => {
  it('reads seconds', () => {
    expect(parseRetryAfter('30', NOW)).toBe(30_000);
    expect(parseRetryAfter(' 2.5 ', NOW)).toBe(2500);
  });

  it('reads an HTTP date relative to the clock', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 12:01:30 GMT', NOW)).toBe(90_000);
  });

  it('treats a date in the past as no wait and junk as unknown', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 11:00:00 GMT', NOW)).toBe(0);
    expect(parseRetryAfter('soon', NOW)).toBeNull();
    expect(parseRetryAfter('', NOW)).toBeNull();
    expect(parseRetryAfter(null, NOW)).toBeNull();
  });

  it('words a wait for a person', () => {
    expect(waitText(1000)).toBe('about 1 second');
    expect(waitText(30_000)).toBe('about 30 seconds');
    expect(waitText(300_000)).toBe('about 5 minutes');
  });
});

describe('send', () => {
  it('always asks for a timeout and refuses redirects', async () => {
    let seen: RequestInit | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await send(options(fetchFn), 'https://platform.example/x', { method: 'POST', headers: { a: 'b' }, body: '{}' });
    expect(seen?.redirect).toBe('error');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.method).toBe('POST');
  });

  it('classifies a refused redirect', async () => {
    const fetchFn = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    }) as unknown as typeof fetch;
    const err = await send(options(fetchFn), 'https://platform.example/x', { method: 'GET', headers: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).kind).toBe('redirect');
    expect((err as PlatformError).ambiguous).toBe(true);
  });

  it('classifies a timeout from a hung server', async () => {
    const fetchFn = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const err = await send(options(fetchFn, { timeoutMs: 20 }), 'https://platform.example/x', { method: 'GET', headers: {} }).catch((e: unknown) => e);
    expect((err as PlatformError).kind).toBe('timeout');
    expect((err as PlatformError).ambiguous).toBe(true);
  });

  it('removes the key from a network error message', async () => {
    const fetchFn = (async () => {
      throw new TypeError(`connect failed for header api-key ${KEY}`);
    }) as unknown as typeof fetch;
    const err = (await send(options(fetchFn), 'https://platform.example/x', { method: 'GET', headers: {} }).catch((e: unknown) => e)) as PlatformError;
    expect(err.kind).toBe('network');
    expect(err.message).not.toContain(KEY);
  });
});

describe('failureFor', () => {
  const res = (status: number, text = '', headers: Record<string, string> = {}) => ({ status, ok: false, text, headers: new Headers(headers) });

  it('maps the status codes the adapters rely on', () => {
    const o = options(fetch);
    expect(failureFor('DEV.to', res(401), o)).toMatchObject({ kind: 'auth', ambiguous: false });
    expect(failureFor('DEV.to', res(403), o).kind).toBe('auth');
    expect(failureFor('DEV.to', res(404), o).kind).toBe('not_found');
    expect(failureFor('DEV.to', res(422, JSON.stringify({ error: 'Title is too long', status: 422 })), o)).toMatchObject({ kind: 'validation', ambiguous: false });
    expect(failureFor('DEV.to', res(500), o)).toMatchObject({ kind: 'server', ambiguous: true });
    expect(failureFor('DEV.to', res(503), o).ambiguous).toBe(true);
    expect(failureFor('DEV.to', res(408), o)).toMatchObject({ kind: 'timeout', ambiguous: true });
  });

  it('shows the platform validation message', () => {
    const err = failureFor('DEV.to', res(422, JSON.stringify({ error: 'Tags: too many tags', status: 422 })), options(fetch));
    expect(err.message).toContain('Tags: too many tags');
    expect(err.detail).toContain('too many tags');
  });

  it('handles 429 with seconds, with a date and with nothing', () => {
    const o = options(fetch);
    const seconds = failureFor('DEV.to', res(429, '', { 'retry-after': '12' }), o);
    expect(seconds).toMatchObject({ kind: 'rate_limit', retryAfterMs: 12_000, ambiguous: false });
    expect(seconds.message).toContain('about 12 seconds');
    const date = failureFor('DEV.to', res(429, '', { 'retry-after': 'Wed, 21 Oct 2026 12:02:00 GMT' }), o);
    expect(date.retryAfterMs).toBe(120_000);
    expect(date.message).toContain('about 2 minutes');
    expect(failureFor('DEV.to', res(429), o).retryAfterMs).toBe(30_000);
  });

  it('only calls a short rate limit worth retrying', () => {
    const o = options(fetch);
    expect(failureFor('DEV.to', res(429, '', { 'retry-after': '3' }), o).transient).toBe(true);
    expect(failureFor('DEV.to', res(429, '', { 'retry-after': '120' }), o).transient).toBe(false);
    expect(failureFor('DEV.to', res(401), o).transient).toBe(false);
    expect(failureFor('DEV.to', res(502), o).transient).toBe(true);
  });

  it('never puts the key in a message, even when the server echoes it', () => {
    const err = failureFor('DEV.to', res(422, JSON.stringify({ error: `bad key ${KEY} in api-key header` })), options(fetch));
    expect(err.message).not.toContain(KEY);
    expect(err.detail).not.toContain(KEY);
  });
});

describe('explanations', () => {
  it('reads the shapes platforms use', () => {
    expect(explanationFrom('plain words')).toBe('plain words');
    expect(explanationFrom(JSON.stringify({ error: 'one' }))).toBe('one');
    expect(explanationFrom(JSON.stringify({ errors: { title: ['is empty'] } }))).toBe('title: is empty');
    expect(explanationFrom('<!doctype html><html></html>')).toBeNull();
    expect(explanationFrom('')).toBeNull();
  });

  it('cleans and shortens', () => {
    expect(clean('a\n\n b', [])).toBe('a b');
    expect(clean('x'.repeat(1000), [], 50)).toHaveLength(50);
  });
});

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { anthropicAdapter, ANTHROPIC_VERSION } from '../src/server/ai/adapters/anthropic';
import { openAiCompatible } from '../src/server/ai/adapters/openai-compatible';
import { AdapterError, parseRetryAfter } from '../src/server/ai/adapters/types';
import { redactSecrets } from '../src/server/ai/redact';

/** A key that looks nothing like a real one, built at run time so no key-shaped text is in the source. */
const fakeKey = () => `fk_${randomBytes(16).toString('hex')}`;
/** An sk- shaped key, assembled from parts for the redaction tests. */
const fakeProviderShaped = () => ['s', 'k-', randomBytes(16).toString('hex')].join('');

const REQUEST = { system: 'Be brief.', user: 'Say ready.', maxOutputTokens: 100, timeoutMs: 2000 };

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (seen: Seen, n: number) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const seen: Seen = { url: String(input), headers, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> };
    calls.push(seen);
    return respond(seen, calls.length);
  }) as typeof fetch;
  return { fn, calls };
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fetch that never answers until its signal fires, like a stuck server. */
const hangingFetch = ((_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as unknown as typeof fetch;

async function failure(promise: Promise<unknown>): Promise<AdapterError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AdapterError);
    return err as AdapterError;
  }
  throw new Error('expected a failure');
}

describe('OpenAI-compatible adapter (Ollama and others)', () => {
  const okBody = { model: 'llama-test', choices: [{ message: { content: '{"operations":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } };

  it('posts chat completions and reads text and usage', async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(okBody));
    const adapter = openAiCompatible({ baseUrl: 'http://localhost:11434/v1/', model: 'llama-test', fetchFn: fn });
    const result = await adapter.complete(REQUEST);
    expect(result).toEqual({ text: '{"operations":[]}', usage: { inputTokens: 12, outputTokens: 5 }, model: 'llama-test', truncated: false });
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0]?.body).toMatchObject({ model: 'llama-test', max_tokens: 100, stream: false });
    expect((calls[0]?.body.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user']);
    // Ollama ignores the key but wants a non-empty header.
    expect(calls[0]?.headers.authorization).toMatch(/^Bearer \S+/);
  });

  it('sends the saved key as a bearer header and reports missing usage as unknown, not zero', async () => {
    const key = fakeKey();
    const { fn, calls } = fakeFetch(() => jsonResponse({ choices: [{ message: { content: 'hi' } }] }));
    const result = await openAiCompatible({ baseUrl: 'https://api.example.test/v1', model: 'm', apiKey: key, fetchFn: fn }).complete(REQUEST);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${key}`);
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it('accepts content given as parts and flags a length stop as truncated', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, finish_reason: 'length' }] }));
    const result = await openAiCompatible({ baseUrl: 'http://x.test/v1', model: 'm', fetchFn: fn }).complete(REQUEST);
    expect(result).toMatchObject({ text: 'ab', truncated: true });
  });

  it('retries once with max_completion_tokens when the server says that is the right name', async () => {
    const { fn, calls } = fakeFetch((_seen, n) =>
      n === 1 ? jsonResponse({ error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } }, 400) : jsonResponse(okBody),
    );
    const result = await openAiCompatible({ baseUrl: 'http://x.test/v1', model: 'm', fetchFn: fn }).complete(REQUEST);
    expect(result.text).toBe('{"operations":[]}');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({ max_completion_tokens: 100 });
    expect(calls[1]?.body).not.toHaveProperty('max_tokens');
  });

  it('fails on malformed answers', async () => {
    for (const body of [{}, { choices: [] }, { choices: [{ message: { content: '' } }] }, { choices: [{ message: {} }] }, 'not json at all']) {
      const { fn } = fakeFetch(() => (typeof body === 'string' ? new Response(body, { status: 200 }) : jsonResponse(body)));
      const err = await failure(openAiCompatible({ baseUrl: 'http://x.test/v1', model: 'm', fetchFn: fn }).complete(REQUEST));
      expect(err.kind).toBe('malformed');
    }
  });

  it('maps 4xx, 5xx and rate limits', async () => {
    const cases: [number, string, boolean][] = [
      [400, 'client', false],
      [401, 'auth', false],
      [403, 'auth', false],
      [404, 'client', false],
      [422, 'client', false],
      [429, 'rate_limit', true],
      [500, 'server', true],
      [502, 'server', true],
      [503, 'server', true],
    ];
    for (const [status, kind, retryable] of cases) {
      const { fn } = fakeFetch(() => jsonResponse({ error: { message: 'nope' } }, status, status === 429 ? { 'retry-after': '2' } : {}));
      const err = await failure(openAiCompatible({ baseUrl: 'http://x.test/v1', model: 'm', fetchFn: fn }).complete(REQUEST));
      expect([status, err.kind, err.retryable]).toEqual([status, kind, retryable]);
      expect(err.status).toBe(status);
    }
  });

  it('does not retry a rate limit that asks for a long wait', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ error: { message: 'slow down' } }, 429, { 'retry-after': '120' }));
    const err = await failure(openAiCompatible({ baseUrl: 'http://x.test/v1', model: 'm', fetchFn: fn }).complete(REQUEST));
    expect(err.kind).toBe('rate_limit');
    expect(err.retryable).toBe(false);
  });

  it('times out, and a timeout is not retried', async () => {
    const err = await failure(openAiCompatible({ baseUrl: 'http://x.test/v1', model: 'm', fetchFn: hangingFetch }).complete({ ...REQUEST, timeoutMs: 30 }));
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(false);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    const pending = openAiCompatible({ baseUrl: 'http://x.test/v1', model: 'm', fetchFn: hangingFetch }).complete({ ...REQUEST, timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    expect((await failure(pending)).kind).toBe('cancelled');
  });

  it('reports a dropped connection as a retryable network error without leaking the key', async () => {
    const key = fakeKey();
    const fn = (async () => {
      throw new TypeError(`fetch failed while sending Bearer ${key}`);
    }) as unknown as typeof fetch;
    const err = await failure(openAiCompatible({ baseUrl: 'http://x.test/v1', model: 'm', apiKey: key, fetchFn: fn }).complete(REQUEST));
    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain(key);
  });

  it('redacts a key that the server echoes in its error', async () => {
    const key = fakeKey();
    const { fn } = fakeFetch(() => jsonResponse({ error: { message: `Incorrect API key provided: ${key}. Check your key.` } }, 401));
    const err = await failure(openAiCompatible({ baseUrl: 'https://api.example.test/v1', model: 'm', apiKey: key, fetchFn: fn }).complete(REQUEST));
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain(key);
    expect(err.message).toContain('[redacted]');
  });
});

describe('Anthropic adapter', () => {
  const okBody = {
    id: 'msg_test',
    type: 'message',
    model: 'claude-test',
    content: [
      { type: 'thinking', thinking: 'internal notes', signature: 'x' },
      { type: 'text', text: '{"operations":[]}' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 30, output_tokens: 9 },
  };

  it('posts to /v1/messages with the documented headers and reads text blocks and usage', async () => {
    const key = fakeKey();
    const { fn, calls } = fakeFetch(() => jsonResponse(okBody));
    const adapter = anthropicAdapter({ baseUrl: 'https://api.anthropic.com', model: 'claude-test', apiKey: key, workspaceId: 'wrkspc_test', fetchFn: fn });
    const result = await adapter.complete(REQUEST);
    expect(result).toEqual({ text: '{"operations":[]}', usage: { inputTokens: 30, outputTokens: 9 }, model: 'claude-test', truncated: false });
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers).toMatchObject({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json', 'anthropic-workspace-id': 'wrkspc_test' });
    expect(calls[0]?.body).toEqual({ model: 'claude-test', max_tokens: 100, system: 'Be brief.', messages: [{ role: 'user', content: 'Say ready.' }] });
  });

  it('omits the workspace header when none is set, and refuses to run without a key', async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(okBody));
    await anthropicAdapter({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: fakeKey(), fetchFn: fn }).complete(REQUEST);
    expect(calls[0]?.headers).not.toHaveProperty('anthropic-workspace-id');
    const err = await failure(anthropicAdapter({ baseUrl: 'https://api.anthropic.com', model: 'm', fetchFn: fn }).complete(REQUEST));
    expect(err.kind).toBe('misconfigured');
    expect(calls).toHaveLength(1);
  });

  it('flags a max_tokens stop as truncated', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ ...okBody, stop_reason: 'max_tokens' }));
    expect((await anthropicAdapter({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: fakeKey(), fetchFn: fn }).complete(REQUEST)).truncated).toBe(true);
  });

  it('fails on malformed answers, refusals and answers with no text', async () => {
    for (const body of [{}, { content: [] }, { content: [{ type: 'thinking', thinking: 'x' }] }, { content: [{ type: 'text', text: 'x' }], stop_reason: 'refusal' }]) {
      const { fn } = fakeFetch(() => jsonResponse(body));
      const err = await failure(anthropicAdapter({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: fakeKey(), fetchFn: fn }).complete(REQUEST));
      expect(err.kind).toBe('malformed');
    }
  });

  it('maps the documented error statuses', async () => {
    const cases: [number, string, boolean][] = [
      [400, 'client', false],
      [401, 'auth', false],
      [403, 'auth', false],
      [404, 'client', false],
      [413, 'client', false],
      [429, 'rate_limit', true],
      [500, 'server', true],
      [529, 'overloaded', true],
    ];
    for (const [status, kind, retryable] of cases) {
      const { fn } = fakeFetch(() => jsonResponse({ type: 'error', error: { type: 'x', message: 'detail' }, request_id: 'req_1' }, status, status === 429 ? { 'retry-after': '1' } : {}));
      const err = await failure(anthropicAdapter({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: fakeKey(), fetchFn: fn }).complete(REQUEST));
      expect([status, err.kind, err.retryable]).toEqual([status, kind, retryable]);
      expect(err.message).toContain('detail');
    }
  });

  it('times out', async () => {
    const err = await failure(anthropicAdapter({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: fakeKey(), fetchFn: hangingFetch }).complete({ ...REQUEST, timeoutMs: 30 }));
    expect(err.kind).toBe('timeout');
  });

  it('never puts the key in an error, even when the server echoes it', async () => {
    const key = fakeKey();
    const { fn } = fakeFetch(() => jsonResponse({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${key}` } }, 401));
    const err = await failure(anthropicAdapter({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: key, fetchFn: fn }).complete(REQUEST));
    expect(err.message).not.toContain(key);
    expect(JSON.stringify(err)).not.toContain(key);
  });
});

describe('redaction and retry-after', () => {
  it('removes known keys, bearer headers and key-shaped text', () => {
    const key = fakeKey();
    const shaped = fakeProviderShaped();
    const text = `failed with ${key}; Authorization: Bearer abcdefghijklmnop; x-api-key: ${shaped}; also ${shaped}`;
    const out = redactSecrets(text, [key]);
    expect(out).not.toContain(key);
    expect(out).not.toContain(shaped);
    expect(out).not.toContain('abcdefghijklmnop');
    expect(redactSecrets('plain text with a uuid 123e4567-e89b-12d3-a456-426614174000')).toContain('123e4567-e89b-12d3-a456-426614174000');
    expect(redactSecrets('short', ['a'])).toBe('short');
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:05 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'))).toBe(5000);
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

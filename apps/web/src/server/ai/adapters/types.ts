import { redactSecrets } from '../redact';

/** One prompt to a model. The adapters add the format their API wants around it. */
export interface CompletionRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  /** Cancels the call. A cancelled call fails with kind 'cancelled'. */
  signal?: AbortSignal | undefined;
  /** Give up after this long. A timeout fails with kind 'timeout'. */
  timeoutMs: number;
}

export interface CompletionResult {
  text: string;
  /** What the provider reported, when it reported anything. Null means "not reported", never zero. */
  usage: { inputTokens: number | null; outputTokens: number | null };
  /** The model the provider says answered, if it says. */
  model: string | null;
  /** The model stopped because it ran out of output tokens, so the text may be cut off. */
  truncated: boolean;
}

export interface ModelAdapter {
  readonly protocol: 'openai_compatible' | 'anthropic';
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export type AdapterErrorKind =
  | 'auth' // the key was refused (401, 403)
  | 'rate_limit' // 429
  | 'overloaded' // 529 or a 503 that asks to retry
  | 'server' // 5xx
  | 'client' // other 4xx: the request was refused
  | 'timeout'
  | 'cancelled'
  | 'network' // could not connect or the connection dropped
  | 'malformed' // the answer was not usable
  | 'misconfigured'; // missing model, address or key

/** A failure of a provider call. The message is written for a person and has had keys removed. */
export class AdapterError extends Error {
  constructor(
    readonly kind: AdapterErrorKind,
    message: string,
    readonly options: { status?: number; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = 'AdapterError';
  }

  /** Worth one more try: the failure is on the provider's side or the connection's, not in the request. */
  get retryable(): boolean {
    if (this.kind === 'rate_limit') return (this.options.retryAfterMs ?? 1000) <= 10_000;
    return this.kind === 'overloaded' || this.kind === 'server' || this.kind === 'network';
  }

  get status(): number | undefined {
    return this.options.status;
  }
}

export interface AdapterConfig {
  baseUrl: string;
  model: string;
  /** The provider key. Never logged, never placed in a message. */
  apiKey?: string | undefined;
  /** Injectable for tests and for the hosted-mode address check. Defaults to the global fetch. */
  fetchFn?: typeof fetch | undefined;
  /** Anthropic only: sent as anthropic-workspace-id when a key spans several workspaces. */
  workspaceId?: string | undefined;
}

/** Seconds or an HTTP date, as a number of milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Pull a readable message out of a provider's error body, whichever of the usual shapes it has. */
export function errorMessageFrom(body: unknown): string | null {
  if (typeof body === 'string') return body.trim() || null;
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as { message: string }).message;
  }
  return typeof record.message === 'string' ? record.message : null;
}

const STATUS_WORDS: Record<number, string> = {
  400: 'The provider rejected the request',
  401: 'The provider did not accept the key',
  403: 'The key is not allowed to do this',
  404: 'The address or model was not found',
  408: 'The provider timed out',
  413: 'The request was too large for the provider',
  422: 'The provider rejected the request',
  429: 'The provider is rate limiting requests',
  500: 'The provider had an internal error',
  502: 'The provider is not reachable (bad gateway)',
  503: 'The provider is unavailable',
  504: 'The provider timed out',
  529: 'The provider is overloaded',
};

/** Map an HTTP failure to an AdapterError with a short, key-free message. */
export function httpFailure(status: number, body: unknown, retryAfter: string | null, secrets: readonly (string | undefined)[]): AdapterError {
  const detail = errorMessageFrom(body);
  const lead = STATUS_WORDS[status] ?? `The provider answered ${status}`;
  const text = redactSecrets(detail ? `${lead}: ${detail.slice(0, 300)}` : lead, secrets);
  const retryAfterMs = parseRetryAfter(retryAfter);
  let kind: AdapterErrorKind;
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 429) kind = 'rate_limit';
  else if (status === 529) kind = 'overloaded';
  else if (status === 408 || status === 504) kind = 'timeout';
  else if (status >= 500) kind = 'server';
  else kind = 'client';
  return new AdapterError(kind, `${text} (HTTP ${status}).`, { status, retryAfterMs });
}

/** Run a fetch with a timeout and a caller's signal, turning every failure into an AdapterError. */
export async function guardedFetch(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  request: Pick<CompletionRequest, 'signal' | 'timeoutMs'>,
  secrets: readonly (string | undefined)[],
): Promise<Response> {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  try {
    return await fetchFn(url, { ...init, signal, redirect: 'error' });
  } catch (err) {
    if (request.signal?.aborted) throw new AdapterError('cancelled', 'The task was cancelled.');
    if (timeout.aborted) {
      throw new AdapterError('timeout', `The provider did not answer within ${Math.round(request.timeoutMs / 1000)} seconds.`);
    }
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw new AdapterError('network', redactSecrets(`Could not reach the provider (${reason}).`, secrets));
  }
}

/** Read a response body as JSON, or as text when it is not JSON. Never throws. */
export async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

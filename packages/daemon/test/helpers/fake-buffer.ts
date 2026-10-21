import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const fixture = <T = unknown>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/http/${name}.json`, import.meta.url)), 'utf8')) as T;

export type BufferOp = 'Organizations' | 'Channels' | 'CreatePost' | 'DeletePost' | 'GetPost';

export interface BufferReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown> | undefined;
  /** The operation name, taken from the query text. */
  op: BufferOp | undefined;
  /** The raw JSON body, for "the key is nowhere" and "this field reached the wire" checks. */
  raw: string;
}

export type BufferReply = { status: number; body?: unknown; headers?: Record<string, string> };

export interface ChannelRow {
  id: string;
  name: string;
  service: string;
  isDisconnected?: boolean;
}

/**
 * A scripted Buffer GraphQL endpoint. It records every request (so a test can count calls and read
 * the exact wire bytes), answers from the fixtures, and lets a test inject faults with `override`.
 */
export class FakeBuffer {
  readonly requests: BufferReq[] = [];
  channels: ChannelRow[] = fixture<{ data: { channels: ChannelRow[] } }>('buffer-channels').data.channels;
  /** Headers added to every successful answer (the remaining-quota headers). */
  quotaHeaders: Record<string, string> = {};
  /** When set, replaces the createPost answer. */
  createPostReply: unknown;
  deleteReply: unknown = fixture('buffer-deletePost');
  getPostReply: unknown = { data: { post: null } };
  override: ((req: BufferReq) => BufferReply | undefined) | undefined;

  constructor(readonly apiKey: string) {}

  readonly fetchFn: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const raw = typeof init?.body === 'string' ? init.body : '';
    const parsed = (raw === '' ? {} : JSON.parse(raw)) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? '';
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] as BufferOp | undefined;
    const req: BufferReq = { url, method: init?.method ?? 'GET', headers, query, variables: parsed.variables, op, raw };
    this.requests.push(req);
    const reply = this.override?.(req) ?? this.#answer(req);
    const payload = reply.body === undefined ? null : JSON.stringify(reply.body);
    return Promise.resolve(
      new Response(payload, {
        status: reply.status,
        headers: { 'content-type': 'application/json', ...this.quotaHeaders, ...reply.headers },
      }),
    );
  };

  #answer(req: BufferReq): BufferReply {
    if (req.headers['authorization'] !== `Bearer ${this.apiKey}`) {
      return { status: 401, body: { errors: [{ message: 'Unauthorized' }] } };
    }
    switch (req.op) {
      case 'Organizations':
        return { status: 200, body: fixture('buffer-account') };
      case 'Channels':
        return { status: 200, body: { data: { channels: this.channels } } };
      case 'CreatePost': {
        if (this.createPostReply !== undefined) return { status: 200, body: this.createPostReply };
        const input = req.variables?.['input'] as { saveToDraft?: boolean } | undefined;
        return { status: 200, body: fixture(input?.saveToDraft === true ? 'buffer-createPost-draft' : 'buffer-createPost-success') };
      }
      case 'DeletePost':
        return { status: 200, body: this.deleteReply };
      case 'GetPost':
        return { status: 200, body: this.getPostReply };
      default:
        return { status: 400, body: { errors: [{ message: `unknown operation in: ${req.query.slice(0, 60)}` }] } };
    }
  }

  get calls(): number {
    return this.requests.length;
  }

  ops(op: BufferOp): BufferReq[] {
    return this.requests.filter((r) => r.op === op);
  }
}

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { defaultResolver, resolvePublic, UrlImportError, type Resolver } from '../import/url';

/**
 * A `fetch` for hosted servers that call a user-supplied address. Same rules as the URL importer: the name is
 * resolved here, every answer must be a public address, and the connection goes to the address that was
 * checked, so a second lookup cannot return something different. Redirects are refused (a provider API has no
 * reason to redirect), the answer is capped at 5 MB, and nothing from the visitor is forwarded.
 */

const MAX_BYTES = 5 * 1024 * 1024;

export interface PinnedRequest {
  url: URL;
  address: string;
  family: 4 | 6;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | undefined;
}
export type PinnedSender = (request: PinnedRequest) => Promise<Response>;

/** One request to one checked address. */
export const sendPinned: PinnedSender = (request) =>
  new Promise((resolve, reject) => {
    const { url } = request;
    const client = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const req = client.request(
      {
        protocol: url.protocol,
        host: hostname,
        servername: net.isIP(hostname) ? undefined : hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: request.headers,
        agent: false,
        lookup: (_name, options, callback) => {
          if (options && typeof options === 'object' && 'all' in options && options.all) {
            (callback as unknown as (err: null, addresses: { address: string; family: number }[]) => void)(null, [{ address: request.address, family: request.family }]);
          } else {
            (callback as unknown as (err: null, address: string, family: number) => void)(null, request.address, request.family);
          }
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_BYTES) {
            res.destroy();
            reject(new Error('The provider answered with more than 5 MB.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502, headers }));
        });
        res.on('error', reject);
      },
    );
    const abort = () => {
      req.destroy();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (request.signal) {
      if (request.signal.aborted) return abort();
      request.signal.addEventListener('abort', abort, { once: true });
    }
    req.on('error', reject);
    req.end(request.body);
  });

export function createSafeFetch(options: { resolve?: Resolver; send?: PinnedSender } = {}): typeof fetch {
  const resolve = options.resolve ?? defaultResolver;
  const send = options.send ?? sendPinned;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    if (url.protocol !== 'https:') throw new Error('only https addresses are called from a hosted server');
    let target;
    try {
      target = await resolvePublic(url, resolve);
    } catch (err) {
      throw new Error(err instanceof UrlImportError ? err.message : 'the address could not be checked');
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    headers.host = url.host;
    const body = typeof init?.body === 'string' ? init.body : undefined;
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    return send({ url, address: target.address, family: target.family, method: init?.method ?? 'GET', headers, body, signal: init?.signal ?? undefined });
  }) as typeof fetch;
}

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { isBlockedAddress, isLocalHostname, parseIp } from './netguard';

/**
 * Fetch a web page for import, safely. The server makes this request, so every step assumes the
 * address is hostile:
 *
 *  - only http and https, no credentials in the address, a short list of ports;
 *  - the name is resolved HERE and every answer must be a public address (one private answer
 *    refuses the whole name, which defeats mixed DNS answers);
 *  - the connection is made to the address that was checked, not to the name, so a second lookup
 *    cannot return something different (DNS rebinding);
 *  - redirects are followed by hand, at most 5, and each hop goes through the same checks;
 *  - the request carries no cookies, no authorization and nothing from the user's session;
 *  - the response is capped in size and time and must be text.
 *
 * `resolve` and `fetchHop` are injectable so the tests exercise all of this without a network.
 */

export const MAX_REDIRECTS = 5;
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const USER_AGENT = 'BrandOS-Importer/1.0 (+read-only article import)';

export type UrlImportErrorCode =
  | 'invalid_url'
  | 'blocked'
  | 'dns_failed'
  | 'too_many_redirects'
  | 'bad_status'
  | 'bad_type'
  | 'too_large'
  | 'timeout'
  | 'failed';

export class UrlImportError extends Error {
  constructor(
    readonly code: UrlImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UrlImportError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface HopRequest {
  url: URL;
  /** The checked address to connect to. The host name is used only for the Host header and TLS. */
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}
export interface HopResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: Uint8Array;
}
export type HopFetcher = (request: HopRequest) => Promise<HopResponse>;

export interface UrlImportDeps {
  resolve?: Resolver;
  fetchHop?: HopFetcher;
}

export interface FetchedPage {
  finalUrl: URL;
  contentType: string;
  /** What the importer sent each hop, for tests and diagnostics. */
  redirects: number;
  body: Uint8Array;
}

export const defaultResolver: Resolver = async (hostname) => {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** One request to one checked address. Node's http(s) client with the connection pinned to it. */
export const defaultFetchHop: HopFetcher = (request) =>
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
        method: 'GET',
        headers: request.headers,
        agent: false,
        // Connect to the address that was validated, whatever the name would resolve to now.
        lookup: (_name, options, callback) => {
          // Newer Node versions may ask for every address ({ all: true }); answer in the form asked for.
          if (options && typeof options === 'object' && 'all' in options && options.all) {
            (callback as unknown as (err: null, addresses: { address: string; family: number }[]) => void)(null, [
              { address: request.address, family: request.family },
            ]);
          } else {
            (callback as unknown as (err: null, address: string, family: number) => void)(null, request.address, request.family);
          }
        },
        timeout: request.timeoutMs,
      },
      (res) => {
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > request.maxBytes) {
          res.destroy();
          reject(new UrlImportError('too_large', `The page is larger than ${Math.round(request.maxBytes / 1024 / 1024)} MB.`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > request.maxBytes) {
            res.destroy();
            reject(new UrlImportError('too_large', `The page is larger than ${Math.round(request.maxBytes / 1024 / 1024)} MB.`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : (value ?? '');
          resolve({ status: res.statusCode ?? 0, headers, body: new Uint8Array(Buffer.concat(chunks)) });
        });
        res.on('error', (err) => reject(err));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new UrlImportError('timeout', 'The site took too long to answer.'));
    });
    req.on('error', (err) => reject(err instanceof UrlImportError ? err : new UrlImportError('failed', 'Could not connect to that address.')));
    req.end();
  });

/** Validate the shape of an address before any lookup. */
export function parseImportUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UrlImportError('invalid_url', 'Enter a full web address, for example https://example-blog.dev/post.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlImportError('invalid_url', 'Only http:// and https:// addresses can be imported.');
  }
  if (url.username || url.password) {
    throw new UrlImportError('invalid_url', 'Addresses with a user name or password in them are not accepted.');
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UrlImportError('blocked', 'That port is not allowed. Use the site’s normal web address.');
  }
  if (isLocalHostname(url.hostname)) {
    throw new UrlImportError('blocked', 'That address points at this computer or a private network, so it was not fetched.');
  }
  return url;
}

/** Resolve a host name and demand that every answer is a public address. */
export async function resolvePublic(url: URL, resolve: Resolver): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = parseIp(host);
  let answers: ResolvedAddress[];
  if (literal) {
    answers = [{ address: host, family: literal.length === 4 ? 4 : 6 }];
  } else {
    try {
      answers = await resolve(host);
    } catch {
      throw new UrlImportError('dns_failed', 'That address could not be found.');
    }
  }
  if (answers.length === 0) throw new UrlImportError('dns_failed', 'That address could not be found.');
  if (answers.some((a) => isBlockedAddress(a.address))) {
    throw new UrlImportError('blocked', 'That address points at this computer or a private network, so it was not fetched.');
  }
  return answers[0]!;
}

const ACCEPTED_TYPES = ['text/html', 'application/xhtml+xml', 'text/markdown', 'text/x-markdown', 'text/plain'];

export function mediaType(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/** Fetch the page, following redirects safely. */
export async function fetchPage(rawUrl: string, deps: UrlImportDeps = {}): Promise<FetchedPage> {
  const resolve = deps.resolve ?? defaultResolver;
  const fetchHop = deps.fetchHop ?? defaultFetchHop;
  const deadline = Date.now() + FETCH_TIMEOUT_MS * 2;
  let current = parseImportUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    current.hash = ''; // a fragment is never sent to the server
    const target = await resolvePublic(current, resolve);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new UrlImportError('timeout', 'The site took too long to answer.');
    let response: HopResponse;
    try {
      response = await fetchHop({
        url: current,
        address: target.address,
        family: target.family,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/markdown;q=0.9,text/plain;q=0.8',
          'accept-encoding': 'identity',
        },
        timeoutMs: Math.min(FETCH_TIMEOUT_MS, remaining),
        maxBytes: MAX_PAGE_BYTES,
      });
    } catch (err) {
      if (err instanceof UrlImportError) throw err;
      throw new UrlImportError('failed', 'Could not fetch that address.');
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location) throw new UrlImportError('bad_status', `The site answered ${response.status} without saying where to go.`);
      if (hop === MAX_REDIRECTS) throw new UrlImportError('too_many_redirects', 'That address redirects too many times.');
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new UrlImportError('invalid_url', 'The site redirected to an address that is not valid.');
      }
      // Re-validate the new address from scratch: scheme, credentials, port, name and every answer.
      current = parseImportUrl(next.toString());
      continue;
    }
    if (response.status !== 200) {
      throw new UrlImportError('bad_status', `The site answered ${response.status}, so there is nothing to import.`);
    }
    const type = mediaType(response.headers['content-type'] ?? '');
    if (!ACCEPTED_TYPES.includes(type)) {
      throw new UrlImportError('bad_type', `That address is ${type || 'an unknown type of file'}, not a web page or Markdown file.`);
    }
    if (response.body.length > MAX_PAGE_BYTES) throw new UrlImportError('too_large', 'The page is larger than 5 MB.');
    current.hash = '';
    return { finalUrl: current, contentType: type, redirects: hop, body: response.body };
  }
  throw new UrlImportError('too_many_redirects', 'That address redirects too many times.');
}

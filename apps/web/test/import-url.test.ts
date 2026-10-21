import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importUrl } from '../src/server/actions/import';
import { sessionToOwner } from '../src/server/actions/owner';
import { forOwner } from '../src/server/data/tenant';
import { isBlockedAddress, isLocalHostname } from '../src/server/import/netguard';
import {
  defaultFetchHop,
  fetchPage,
  MAX_PAGE_BYTES,
  MAX_REDIRECTS,
  UrlImportError,
  type HopRequest,
  type HopResponse,
  type Resolver,
} from '../src/server/import/url';
import { POST as importUrlRoute } from '../src/app/api/articles/import/url/route';
import { hostedHarness, type HostedHarness, type TestUser } from './hosted-harness';

const PUBLIC_IP = '93.184.216.34';

const ARTICLE_HTML = `<!doctype html><html lang="en"><head><title>Tuning a connection pool - Example Blog</title>
<meta property="og:site_name" content="Example Blog"></head><body>
<header><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>
<article><h1>Tuning a connection pool</h1>
<p class="byline">By the author</p>
<p>Connection pools hide latency until they run out. This post walks through sizing one for a service that talks to Postgres,
with measurements, a few mistakes we made, and the settings we ended up with. It is long enough for the extractor to treat it as the main content of the page.</p>
<p>Start with <a href="/guides/pooling">the pooling guide</a> and the <a href="https://example.test/docs">official docs</a>.</p>
<h2>The settings</h2>
<pre class="language-go"><code class="language-go"><span class="token">func</span> open() {
	db.SetMaxOpenConns(20)
}</code></pre>
<table><thead><tr><th>Pool size</th><th>p99 latency</th></tr></thead><tbody><tr><td>10</td><td>180 ms</td></tr><tr><td>20</td><td>95 ms</td></tr></tbody></table>
<p>The graph below shows the effect.</p>
<img src="/img/graph.png" alt="Latency by pool size">
<p>That is all the measuring we did; the rest is judgment about your own workload and how much headroom you want to keep for bursts of traffic.</p>
</article>
<footer>Copyright</footer>
<script>window.track = true</script></body></html>`;

interface Recorder {
  resolver: Resolver;
  resolved: string[];
  fetchHop: (req: HopRequest) => Promise<HopResponse>;
  requests: HopRequest[];
}

function harness(opts: {
  dns?: Record<string, string[]>;
  pages?: Record<string, HopResponse | ((req: HopRequest) => HopResponse)>;
}): Recorder {
  const resolved: string[] = [];
  const requests: HopRequest[] = [];
  return {
    resolved,
    requests,
    resolver: async (host) => {
      resolved.push(host);
      const answers = opts.dns?.[host] ?? [PUBLIC_IP];
      return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    fetchHop: async (req) => {
      requests.push(req);
      const entry = opts.pages?.[req.url.toString()];
      if (!entry) return { status: 404, headers: {}, body: new Uint8Array() };
      return typeof entry === 'function' ? entry(req) : entry;
    },
  };
}

const html = (body: string, type = 'text/html; charset=utf-8'): HopResponse => ({
  status: 200,
  headers: { 'content-type': type },
  body: new TextEncoder().encode(body),
});
const redirect = (to: string, status = 302): HopResponse => ({ status, headers: { location: to }, body: new Uint8Array() });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof UrlImportError) return err.code;
    throw err;
  }
  return 'ok';
}

describe('address rules', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255',
    '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.255', '240.0.0.1',
    '255.255.255.255', '192.0.2.5', '198.18.0.1', '198.51.100.7', '203.0.113.9',
    '::1', '::', 'fe80::1', 'fe80::abcd:1234', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3',
    '::ffff:a9fe:a9fe', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1',
    'not-an-ip', '',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8', '93.184.216.34', '1.1.1.1', '172.15.255.255', '172.32.0.1', '11.0.0.1', '100.63.255.255', '100.128.0.1', '192.169.0.1',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808',
  ])('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it('refuses local-looking host names without a lookup', () => {
    for (const name of ['localhost', 'LOCALHOST.', 'app.localhost', 'printer.local', 'metadata.google.internal', 'intranet', 'router.home.arpa']) {
      expect(isLocalHostname(name), name).toBe(true);
    }
    for (const name of ['example-blog.dev', 'www.example.test', '127.0.0.1', '[::1]']) {
      expect(isLocalHostname(name), name).toBe(false);
    }
  });
});

describe('fetching a page safely', () => {
  it('fetches a public page, pinned to the checked address, with no cookies or credentials', async () => {
    const r = harness({ pages: { 'https://blog.example.test/post': html(ARTICLE_HTML) } });
    const page = await fetchPage('https://blog.example.test/post#section', { resolve: r.resolver, fetchHop: r.fetchHop });
    expect(page.finalUrl.toString()).toBe('https://blog.example.test/post');
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]!.address).toBe(PUBLIC_IP);
    const headers = Object.keys(r.requests[0]!.headers).map((h) => h.toLowerCase());
    expect(headers).not.toContain('cookie');
    expect(headers).not.toContain('authorization');
    expect(r.requests[0]!.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(r.requests[0]!.maxBytes).toBe(MAX_PAGE_BYTES);
  });

  it.each([
    ['ftp://example.test/file', 'invalid_url'],
    ['file:///etc/passwd', 'invalid_url'],
    ['javascript:alert(1)', 'invalid_url'],
    ['data:text/html,hi', 'invalid_url'],
    ['gopher://example.test/', 'invalid_url'],
    ['not a url', 'invalid_url'],
    ['http://user:pass@example.test/', 'invalid_url'],
    ['https://example.test:22/', 'blocked'],
    ['https://example.test:6379/', 'blocked'],
    ['http://localhost/', 'blocked'],
    ['http://localhost:3100/api/health', 'blocked'],
    ['http://app.localhost/', 'blocked'],
    ['http://127.0.0.1/', 'blocked'],
    ['http://127.1/', 'blocked'],
    ['http://2130706433/', 'blocked'],
    ['http://0x7f.0.0.1/', 'blocked'],
    ['http://0177.0.0.1/', 'blocked'],
    ['http://10.0.0.5/', 'blocked'],
    ['http://192.168.1.10/admin', 'blocked'],
    ['http://172.16.5.4/', 'blocked'],
    ['http://169.254.169.254/latest/meta-data/', 'blocked'],
    ['http://[::1]/', 'blocked'],
    ['http://[::ffff:127.0.0.1]/', 'blocked'],
    ['http://[::ffff:7f00:1]/', 'blocked'],
    ['http://[fe80::1]/', 'blocked'],
    ['http://[fd00::1]/', 'blocked'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'blocked'],
    ['http://0.0.0.0/', 'blocked'],
  ])('refuses %s before any request is made', async (url, code) => {
    const r = harness({});
    expect(await codeOf(fetchPage(url, { resolve: r.resolver, fetchHop: r.fetchHop }))).toBe(code);
    expect(r.requests).toEqual([]);
  });

  it('refuses a name that resolves to a private address', async () => {
    for (const answer of [['10.0.0.8'], ['127.0.0.1'], ['169.254.169.254'], ['::1'], ['fe80::1'], ['::ffff:192.168.0.1']]) {
      const r = harness({ dns: { 'sneaky.example.test': answer } });
      expect(await codeOf(fetchPage('https://sneaky.example.test/', { resolve: r.resolver, fetchHop: r.fetchHop }))).toBe('blocked');
      expect(r.requests).toEqual([]);
    }
  });

  it('refuses a name when ANY answer is private (mixed answers)', async () => {
    const r = harness({ dns: { 'mixed.example.test': [PUBLIC_IP, '10.0.0.8'] } });
    expect(await codeOf(fetchPage('https://mixed.example.test/', { resolve: r.resolver, fetchHop: r.fetchHop }))).toBe('blocked');
    expect(r.requests).toEqual([]);
  });

  it('reports a name that does not resolve', async () => {
    const failing: Resolver = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await codeOf(fetchPage('https://nope.example.test/', { resolve: failing, fetchHop: harness({}).fetchHop }))).toBe('dns_failed');
    const empty: Resolver = async () => [];
    expect(await codeOf(fetchPage('https://nope.example.test/', { resolve: empty, fetchHop: harness({}).fetchHop }))).toBe('dns_failed');
  });

  it('connects to the address it checked even if the name would now resolve elsewhere (rebinding)', async () => {
    let calls = 0;
    const rebinding: Resolver = async () => {
      calls += 1;
      // First answer is public; any later answer would be loopback.
      return [{ address: calls === 1 ? PUBLIC_IP : '127.0.0.1', family: 4 }];
    };
    const r = harness({ pages: { 'https://rebind.example.test/': html(ARTICLE_HTML) } });
    await fetchPage('https://rebind.example.test/', { resolve: rebinding, fetchHop: r.fetchHop });
    expect(calls).toBe(1);
    expect(r.requests[0]!.address).toBe(PUBLIC_IP);
  });

  it('re-checks every redirect hop and refuses one that leads to a private address', async () => {
    const r = harness({
      dns: { 'internal.example.test': ['192.168.0.9'] },
      pages: {
        'https://blog.example.test/a': redirect('https://internal.example.test/secret'),
        'https://blog.example.test/b': redirect('http://127.0.0.1:8080/admin'),
        'https://blog.example.test/c': redirect('http://169.254.169.254/latest/meta-data/'),
        'https://blog.example.test/d': redirect('http://[::1]/'),
        'https://blog.example.test/e': redirect('file:///etc/passwd'),
        'https://blog.example.test/f': redirect('ftp://example.test/x'),
        'https://blog.example.test/g': redirect('http://user:pw@other.example.test/'),
      },
    });
    for (const path of ['a', 'b', 'c', 'd']) {
      expect(await codeOf(fetchPage(`https://blog.example.test/${path}`, { resolve: r.resolver, fetchHop: r.fetchHop })), path).toBe('blocked');
    }
    for (const path of ['e', 'f', 'g']) {
      expect(await codeOf(fetchPage(`https://blog.example.test/${path}`, { resolve: r.resolver, fetchHop: r.fetchHop })), path).toBe('invalid_url');
    }
    // Only the first hop of each chain was ever requested; the private target never was.
    expect(r.requests.every((req) => req.url.hostname === 'blog.example.test')).toBe(true);
  });

  it('follows relative redirects, and allows exactly five', async () => {
    const pages: Record<string, HopResponse> = {};
    for (let i = 0; i < MAX_REDIRECTS; i++) pages[`https://blog.example.test/r${i}`] = redirect(`/r${i + 1}`);
    pages[`https://blog.example.test/r${MAX_REDIRECTS}`] = html(ARTICLE_HTML);
    const r = harness({ pages });
    const page = await fetchPage('https://blog.example.test/r0', { resolve: r.resolver, fetchHop: r.fetchHop });
    expect(page.redirects).toBe(MAX_REDIRECTS);
    expect(r.requests).toHaveLength(MAX_REDIRECTS + 1);
    expect(r.resolved).toHaveLength(MAX_REDIRECTS + 1);
  });

  it('stops after more than five redirects, including a loop', async () => {
    const loop = harness({ pages: { 'https://blog.example.test/loop': redirect('/loop') } });
    expect(await codeOf(fetchPage('https://blog.example.test/loop', { resolve: loop.resolver, fetchHop: loop.fetchHop }))).toBe('too_many_redirects');
    expect(loop.requests).toHaveLength(MAX_REDIRECTS + 1);
  });

  it('refuses answers that are not a web page', async () => {
    for (const type of ['image/png', 'application/json', 'application/pdf', 'application/octet-stream', '']) {
      const r = harness({ pages: { 'https://blog.example.test/x': html('body', type) } });
      expect(await codeOf(fetchPage('https://blog.example.test/x', { resolve: r.resolver, fetchHop: r.fetchHop })), type).toBe('bad_type');
    }
    for (const type of ['text/html', 'text/html; charset=iso-8859-1', 'application/xhtml+xml', 'text/markdown', 'text/plain']) {
      const r = harness({ pages: { 'https://blog.example.test/x': html('body', type) } });
      expect(await codeOf(fetchPage('https://blog.example.test/x', { resolve: r.resolver, fetchHop: r.fetchHop })), type).toBe('ok');
    }
  });

  it('refuses error statuses and oversized bodies', async () => {
    const r = harness({
      pages: {
        'https://blog.example.test/missing': { status: 404, headers: {}, body: new Uint8Array() },
        'https://blog.example.test/err': { status: 500, headers: {}, body: new Uint8Array() },
        'https://blog.example.test/huge': { status: 200, headers: { 'content-type': 'text/html' }, body: new Uint8Array(MAX_PAGE_BYTES + 1) },
        'https://blog.example.test/nowhere': { status: 302, headers: {}, body: new Uint8Array() },
      },
    });
    const run = (p: string) => codeOf(fetchPage(`https://blog.example.test/${p}`, { resolve: r.resolver, fetchHop: r.fetchHop }));
    expect(await run('missing')).toBe('bad_status');
    expect(await run('err')).toBe('bad_status');
    expect(await run('huge')).toBe('too_large');
    expect(await run('nowhere')).toBe('bad_status');
  });

  it('turns a failing connection into a plain error', async () => {
    const boom = async (): Promise<HopResponse> => {
      throw new Error('socket hang up');
    };
    expect(await codeOf(fetchPage('https://blog.example.test/', { resolve: async () => [{ address: PUBLIC_IP, family: 4 }], fetchHop: boom }))).toBe('failed');
  });
});

describe('the real one-hop fetcher', () => {
  let server: http.Server;
  let port: number;
  let hits: { host: string | undefined; cookie: string | undefined; auth: string | undefined }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push({ host: req.headers.host, cookie: req.headers.cookie, auth: req.headers.authorization });
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(Buffer.alloc(2048, 65));
      } else if (req.url === '/slow') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('start');
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<p>hello</p>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const req = (path: string, overrides: Partial<HopRequest> = {}): HopRequest => ({
    url: new URL(`http://pinned.example.test:${port}${path}`),
    address: '127.0.0.1',
    family: 4,
    headers: { 'user-agent': 'test' },
    timeoutMs: 1000,
    maxBytes: 1024,
    ...overrides,
  });

  it('connects to the pinned address while sending the original host name, and no cookies', async () => {
    hits = [];
    const res = await defaultFetchHop(req('/'));
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe('<p>hello</p>');
    expect(hits[0]!.host).toBe(`pinned.example.test:${port}`);
    expect(hits[0]!.cookie).toBeUndefined();
    expect(hits[0]!.auth).toBeUndefined();
  });

  it('stops reading a body that is too large', async () => {
    await expect(defaultFetchHop(req('/big'))).rejects.toMatchObject({ code: 'too_large' });
  });

  it('gives up on a server that never finishes', async () => {
    await expect(defaultFetchHop(req('/slow', { timeoutMs: 150 }))).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('importing a page', () => {
  let h: HostedHarness;
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    h = await hostedHarness();
    a = await h.signUp('url.a@example.test', 'A');
    b = await h.signUp('url.b@example.test', 'B');
  });
  afterAll(async () => {
    await h.close();
  });

  const owner = (user: TestUser) => sessionToOwner({ userId: user.userId }, h.ctx);

  it('extracts the article and keeps the code block, table, links and image', async () => {
    const r = harness({ pages: { 'https://blog.example.test/pool': html(ARTICLE_HTML) } });
    const result = await importUrl(owner(a), { url: 'https://blog.example.test/pool' }, { resolve: r.resolver, fetchHop: r.fetchHop });
    const { article } = result;
    expect(article.title).toContain('Tuning a connection pool');
    expect(article.canonicalUrl).toBe('https://blog.example.test/pool');
    expect(article.sourceKind).toBe('url');
    expect(article.sourceRef).toBe('https://blog.example.test/pool');
    expect(article.status).toBe('draft');
    const md = article.bodyMarkdown;
    expect(md).toContain('```go');
    expect(md).toContain('db.SetMaxOpenConns(20)');
    expect(md).toMatch(/\| Pool size \| p99 latency \|/);
    expect(md).toContain('[the pooling guide](https://blog.example.test/guides/pooling)');
    expect(md).toContain('[official docs](https://example.test/docs)');
    expect(md).toContain('![Latency by pool size](https://blog.example.test/img/graph.png)');
    expect(md).not.toContain('window.track');
    expect(result.warnings.join(' ')).toContain('Images stay on the original site');

    const versions = await forOwner(a.userId, h.ctx.db).articles.listVersions(article.id);
    expect(versions.map((v) => v.reason)).toEqual(['import']);
  });

  it('imports a Markdown file from a URL with its front matter and defaults the canonical to the source', async () => {
    const md = '---\ntitle: Remote notes\ntags: [a, b]\n---\n\nHello from a remote file.\n';
    const r = harness({ pages: { 'https://raw.example.test/notes.md': html(md, 'text/markdown') } });
    const { article } = await importUrl(owner(a), { url: 'https://raw.example.test/notes.md' }, { resolve: r.resolver, fetchHop: r.fetchHop });
    expect(article).toMatchObject({ title: 'Remote notes', tags: ['a', 'b'], canonicalUrl: 'https://raw.example.test/notes.md' });
    expect(article.bodyMarkdown).toBe('Hello from a remote file.\n');
  });

  it('turns SSRF refusals into a clear field error and creates nothing', async () => {
    const before = (await forOwner(a.userId, h.ctx.db).articles.counts()).total;
    const r = harness({});
    await expect(importUrl(owner(a), { url: 'http://169.254.169.254/latest/meta-data/' }, { resolve: r.resolver, fetchHop: r.fetchHop })).rejects.toMatchObject({
      code: 'invalid',
      fields: { url: expect.stringContaining('private network') },
    });
    expect((await forOwner(a.userId, h.ctx.db).articles.counts()).total).toBe(before);
  });

  it('explains a page with no article instead of saving an empty draft', async () => {
    const r = harness({ pages: { 'https://blog.example.test/empty': html('<html><body></body></html>') } });
    const before = (await forOwner(a.userId, h.ctx.db).articles.counts()).total;
    await expect(importUrl(owner(a), { url: 'https://blog.example.test/empty' }, { resolve: r.resolver, fetchHop: r.fetchHop })).rejects.toMatchObject({ code: 'invalid' });
    expect((await forOwner(a.userId, h.ctx.db).articles.counts()).total).toBe(before);
  });

  it('works through the route, files the article under the signed-in user only, and needs a session', async () => {
    const r = harness({ pages: { 'https://blog.example.test/route': html(ARTICLE_HTML) } });
    const call = (user: TestUser | null, url: string) =>
      importUrlRoute(h.request(user, 'POST', '/api/articles/import/url', { url }));
    expect((await call(null, 'https://blog.example.test/route')).status).toBe(401);
    // The route uses the real resolver and fetcher, which tests must never reach: a blocked address proves the guard runs first.
    const blocked = await call(b, 'http://127.0.0.1/api/health');
    expect(blocked.status).toBe(400);
    expect(((await blocked.json()) as { fields: { url: string } }).fields.url).toContain('private network');
    void r;
  });
});

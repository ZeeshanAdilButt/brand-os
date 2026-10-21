import { buildContentItem, type ContentItem } from '@cph/core';
import { describe, expect, it } from 'vitest';
import { CANONICAL_HOST, checkCanonicalLive, decodeHtmlEntities, LIVE_CHECK_TIMEOUT_MS } from '../src/live-check.js';

function item(title: string, published = true): ContentItem {
  const mdxRaw = [
    '---',
    `title: ${JSON.stringify(title)}`,
    'date: "2026-07-19"',
    'category: "engineering"',
    'tags: ["prometheus"]',
    'description: "A description."',
    `published: ${String(published)}`,
    'coverImage: "/images/blogs-covers/prometheus-cardinality.svg"',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');
  return buildContentItem({
    slug: 'a-post',
    mdxRaw,
    repoCommit: 'abc123',
    dirty: false,
    baseUrl: 'https://www.example-blog.dev',
  });
}

/** A Response whose `url` is the post-redirect URL (a hand-made Response has an empty one). */
function respond(body: string, status: number, url: string): Response {
  const res = new Response(body, { status });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

interface Recorded {
  fetchFn: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
}

function fakeFetch(reply: (url: string) => Response | Promise<Response>): Recorded {
  const calls: Recorded['calls'] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(reply(url));
  }) as typeof fetch;
  return { fetchFn, calls };
}

const LIVE = 'https://www.example-blog.dev/blog/a-post';
const TITLE = 'How High Cardinality Hurts Prometheus';

describe('checkCanonicalLive', () => {
  it('is ok for a 200 on the www host whose HTML contains the title', async () => {
    const { fetchFn, calls } = fakeFetch((url) =>
      respond(`<html><head><title>${TITLE}</title></head></html>`, 200, url),
    );
    const result = await checkCanonicalLive(item(TITLE), fetchFn);
    expect(result).toEqual({ ok: true, status: 200, finalUrl: LIVE });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(LIVE);
    expect(calls[0]?.init?.redirect).toBe('follow');
  });

  it('a 200 soft-404 page without the title is title-missing', async () => {
    const { fetchFn } = fakeFetch((url) => respond('<html><h1>404 - This page could not be found</h1></html>', 200, url));
    expect(await checkCanonicalLive(item(TITLE), fetchFn)).toEqual({
      ok: false,
      status: 200,
      finalUrl: LIVE,
      reason: 'title-missing',
    });
  });

  it('a redirect that ends on the apex host is host, even with the title on the page', async () => {
    const apex = 'https://example-blog.dev/blog/a-post';
    const { fetchFn } = fakeFetch(() => respond(`<title>${TITLE}</title>`, 200, apex));
    expect(await checkCanonicalLive(item(TITLE), fetchFn)).toEqual({
      ok: false,
      status: 200,
      finalUrl: apex,
      reason: 'host',
    });
  });

  it('a lookalike host is not the canonical host', async () => {
    const evil = 'https://www.example-blog.dev.example.net/blog/a-post';
    const { fetchFn } = fakeFetch(() => respond(`<title>${TITLE}</title>`, 200, evil));
    expect((await checkCanonicalLive(item(TITLE), fetchFn)).reason).toBe('host');
    expect(CANONICAL_HOST).toBe('www.example-blog.dev');
  });

  it('a non-200 status is status (a 404 and a 500 alike)', async () => {
    for (const code of [404, 500]) {
      const { fetchFn } = fakeFetch((url) => respond(`<title>${TITLE}</title>`, code, url));
      expect(await checkCanonicalLive(item(TITLE), fetchFn)).toEqual({
        ok: false,
        status: code,
        finalUrl: LIVE,
        reason: 'status',
      });
    }
  });

  it('published: false is not-published and makes no fetch at all', async () => {
    const { fetchFn, calls } = fakeFetch((url) => respond(`<title>${TITLE}</title>`, 200, url));
    const result = await checkCanonicalLive(item(TITLE, false), fetchFn);
    expect(result).toMatchObject({ ok: false, reason: 'not-published' });
    expect(calls).toHaveLength(0);
  });

  it('a fetch that throws is network', async () => {
    const fetchFn = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    expect(await checkCanonicalLive(item(TITLE), fetchFn)).toEqual({
      ok: false,
      status: 0,
      finalUrl: LIVE,
      reason: 'network',
    });
  });

  it('a body that fails mid-read is network', async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('connection reset'));
        },
      }),
      { status: 200 },
    );
    Object.defineProperty(broken, 'url', { value: LIVE });
    const result = await checkCanonicalLive(item(TITLE), (() => Promise.resolve(broken)) as typeof fetch);
    expect(result).toMatchObject({ ok: false, status: 200, reason: 'network' });
  });

  it('passes an abort signal, and a hung connection ends as network when it fires', async () => {
    expect(LIVE_CHECK_TIMEOUT_MS).toBe(15_000);
    let seen: AbortSignal | undefined;
    const hung = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        seen = init?.signal ?? undefined;
        seen?.addEventListener('abort', () => reject(seen?.reason as Error));
      })) as typeof fetch;
    const result = await checkCanonicalLive(item(TITLE), hung, 20);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ ok: false, status: 0, finalUrl: LIVE, reason: 'network' });
  });

  it('the default request carries a (not yet fired) signal', async () => {
    const { fetchFn, calls } = fakeFetch((url) => respond(`<title>${TITLE}</title>`, 200, url));
    await checkCanonicalLive(item(TITLE), fetchFn);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init?.signal?.aborted).toBe(false);
  });

  it('falls back to the requested URL when the response carries no url', async () => {
    const { fetchFn } = fakeFetch(() => new Response(`<title>${TITLE}</title>`, { status: 200 }));
    expect(await checkCanonicalLive(item(TITLE), fetchFn)).toMatchObject({ ok: true, finalUrl: LIVE });
  });

  describe('titles with an apostrophe', () => {
    const apos = "Why Prometheus Can't Keep Up";
    for (const encoded of ['&#x27;', '&#39;', '&apos;', '&#X27;', '&#039;']) {
      it(`matches HTML that encodes it as ${encoded}`, async () => {
        const html = `<title>Why Prometheus Can${encoded}t Keep Up</title>`;
        const { fetchFn } = fakeFetch((url) => respond(html, 200, url));
        expect((await checkCanonicalLive(item(apos), fetchFn)).ok).toBe(true);
      });
    }

    it('matches a literal apostrophe too', async () => {
      const { fetchFn } = fakeFetch((url) => respond(`<h1>${apos}</h1>`, 200, url));
      expect((await checkCanonicalLive(item(apos), fetchFn)).ok).toBe(true);
    });

    it('&rsquo; decodes to a different character and does NOT match a straight apostrophe (pinned)', async () => {
      const { fetchFn } = fakeFetch((url) => respond('<title>Why Prometheus Can&rsquo;t Keep Up</title>', 200, url));
      expect(await checkCanonicalLive(item(apos), fetchFn)).toMatchObject({ ok: false, reason: 'title-missing' });
      expect(decodeHtmlEntities('Can&rsquo;t')).toBe('Can’t');
    });
  });

  it('compares against the raw title: "&", quotes and angle brackets match their escaped forms', async () => {
    const title = 'Caches & "Queues" <In Practice>';
    const html = '<title>Caches &amp; &quot;Queues&quot; &lt;In Practice&gt;</title>';
    const { fetchFn } = fakeFetch((url) => respond(html, 200, url));
    expect((await checkCanonicalLive(item(title), fetchFn)).ok).toBe(true);
  });

  it('does not decode twice: an escaped escape stays literal', async () => {
    const { fetchFn } = fakeFetch((url) => respond('<title>Can&amp;#39;t Stop</title>', 200, url));
    expect((await checkCanonicalLive(item("Can't Stop"), fetchFn)).reason).toBe('title-missing');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes named, decimal and hex references', () => {
    expect(decodeHtmlEntities('&amp; &lt; &gt; &quot; &apos; &#39; &#x27; &#X27; &nbsp;|')).toBe(
      `& < > " ' ' ' '  |`,
    );
    expect(decodeHtmlEntities('&mdash; &ndash; &hellip; &ldquo;x&rdquo; &lsquo;y&rsquo;')).toBe(
      '— – … “x” ‘y’',
    );
    expect(decodeHtmlEntities('&#x1F600;')).toBe('\u{1F600}');
  });

  it('leaves unknown names and invalid code points untouched', () => {
    expect(decodeHtmlEntities('&notathing; &#xFFFFFFFF; &#0; & x; &amp')).toBe(
      '&notathing; &#xFFFFFFFF; &#0; & x; &amp',
    );
  });
});

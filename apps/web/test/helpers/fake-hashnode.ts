/**
 * A small fake of the Hashnode GraphQL operations the adapter uses, for tests only. It follows the shapes in
 * the official schema (INTEGRATIONS.md) and answers errors as HTTP 200 with an `errors[]` array, as Hashnode
 * documents. It never reaches the network.
 */

export interface FakeDraft {
  id: string;
  input: Record<string, unknown>;
}

export interface FakePost {
  id: string;
  title: string;
  url: string;
  slug: string;
  canonicalUrl: string | null;
}

export interface HashnodeInjection {
  /** Tested against the GraphQL query text. */
  match: RegExp;
  /** An HTTP-level answer. */
  http?: { status: number; headers?: Record<string, string>; body?: unknown };
  /** A GraphQL error answered with HTTP 200. */
  gqlError?: { code: string; message: string };
  drop?: boolean;
  hang?: boolean;
  afterApply?: boolean;
  times?: number;
}

export interface FakeHashnode {
  readonly token: string;
  readonly origin: string;
  drafts: Map<string, FakeDraft>;
  posts: FakePost[];
  requests: { query: string; variables: Record<string, unknown>; headers: Record<string, string> }[];
  /** Operation names seen, in order. */
  operations(): string[];
  proPlan: boolean;
  fetch: typeof fetch;
  inject(i: HashnodeInjection): void;
}

export function createFakeHashnode(options: { token: string; origin?: string; publications?: { id: string; title: string }[] }): FakeHashnode {
  const origin = (options.origin ?? 'https://fake-hashnode.example.test/').replace(/\/?$/, '/');
  const publications = options.publications ?? [{ id: '650000000000000000000001', title: 'Example Engineering Blog' }];
  const drafts = new Map<string, FakeDraft>();
  const posts: FakePost[] = [];
  const requests: FakeHashnode['requests'] = [];
  const injections: (HashnodeInjection & { left: number })[] = [];
  let counter = 1;
  const newId = () => `65a${String(counter++).padStart(21, '0')}`;

  const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  const gqlError = (code: string, message: string) =>
    new Response(JSON.stringify({ data: null, errors: [{ message, extensions: { code } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const PRO = 'Publication does not have an active Pro plan. Upgrade in your dashboard to access this via the API.';

  const fake: FakeHashnode = {
    token: options.token,
    origin,
    drafts,
    posts,
    requests,
    proPlan: true,
    operations: () => requests.map((r) => /(?:query|mutation)\s+(\w+)/.exec(r.query)?.[1] ?? '?'),
    inject: (i) => injections.push({ ...i, left: i.times ?? 1 }),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      const parsed = JSON.parse(await request.text()) as { query: string; variables: Record<string, unknown> };
      requests.push({ query: parsed.query, variables: parsed.variables, headers });
      const vars = parsed.variables;
      const q = parsed.query;

      if (headers.authorization !== `Bearer ${options.token}`) return gqlError('UNAUTHENTICATED', 'You must be authenticated.');

      const injection = injections.find((i) => i.left > 0 && i.match.test(q));
      const run = (): Response => {
        const input = vars.input as Record<string, unknown> | undefined;
        if (/\bme\b/.test(q) && /publications/.test(q)) {
          return ok({ me: { id: '1', username: 'fakewriter', name: 'Fake Writer', publications: { edges: publications.map((p) => ({ node: { ...p, url: `${origin}${p.id}`, isTeam: false } })) } } });
        }
        if (/createDraft/.test(q)) {
          if (!fake.proPlan) return gqlError('FORBIDDEN', PRO);
          if (!input || typeof input.title !== 'string' || input.title.trim() === '') return gqlError('BAD_USER_INPUT', 'title must not be empty');
          const id = newId();
          drafts.set(id, { id, input });
          return ok({ createDraft: { draft: { id, slug: 'draft-slug' } } });
        }
        if (/updateDraft/.test(q)) {
          if (!fake.proPlan) return gqlError('FORBIDDEN', PRO);
          const draft = drafts.get(String(input?.draftId));
          if (!draft) return gqlError('NOT_FOUND', 'Draft not found');
          draft.input = { ...draft.input, ...input };
          return ok({ updateDraft: { draft: { id: draft.id, slug: 'draft-slug' } } });
        }
        if (/publishDraft/.test(q)) {
          if (!fake.proPlan) return gqlError('FORBIDDEN', PRO);
          const draft = drafts.get(String(input?.draftId));
          if (!draft) return gqlError('NOT_FOUND', 'Draft not found');
          drafts.delete(draft.id);
          const post: FakePost = {
            id: newId(),
            title: String(draft.input.title),
            slug: 'post-slug',
            url: `${origin}post/${draft.id}`,
            canonicalUrl: (draft.input.originalArticleURL as string | null | undefined) ?? null,
          };
          posts.unshift(post);
          return ok({ publishDraft: { post: { id: post.id, slug: post.slug, url: post.url } } });
        }
        if (/draft\(id/.test(q)) {
          if (!fake.proPlan) return gqlError('FORBIDDEN', PRO);
          const draft = drafts.get(String(vars.id));
          return draft ? ok({ draft: { id: draft.id } }) : gqlError('NOT_FOUND', 'Draft not found');
        }
        if (/publication\(id/.test(q)) {
          if (!fake.proPlan) return gqlError('FORBIDDEN', PRO);
          return ok({ publication: { posts: { edges: posts.map((node) => ({ node })) } } });
        }
        return gqlError('BAD_USER_INPUT', 'unknown operation');
      };

      if (injection) {
        injection.left -= 1;
        if (injection.afterApply) run();
        if (injection.hang) {
          return new Promise<Response>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason)));
        }
        if (injection.drop) throw new TypeError('fetch failed', { cause: new Error('socket hang up') });
        if (injection.http) {
          const { status, headers: h, body } = injection.http;
          return new Response(typeof body === 'string' ? body : JSON.stringify(body ?? {}), { status, headers: h });
        }
        if (injection.gqlError) return gqlError(injection.gqlError.code, injection.gqlError.message);
      }
      return run();
    }) as typeof fetch,
  };
  return fake;
}

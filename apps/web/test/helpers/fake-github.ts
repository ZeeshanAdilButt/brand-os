import http from 'node:http';
import { createHash } from 'node:crypto';

/**
 * A small fake of the GitHub REST pieces the personal-site adapter uses: the repository, a branch ref, file
 * contents, creating a ref, committing a file and opening a pull request. A test helper only: tests call
 * `fake.fetch` as an injected fetch, and `serveFakeGithub` puts the same logic behind a local HTTP port for the
 * manual browser run. It never reaches the network.
 *
 * The fake is deliberately permissive about WHICH branch a write names, so a test can prove the adapter never
 * writes to the base branch: it logs every request and exposes the base branch's sha.
 *
 * Failure injection is the same as the DEV.to fake: `fake.inject({ match, ... })` for the next matching request.
 */

export interface LoggedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Injection {
  /** Tested against `METHOD path`, for example `/POST \/repos\/.+\/pulls/`. */
  match: RegExp;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  hang?: boolean;
  drop?: boolean;
  redirect?: string;
  /** Apply the request's effect, then misbehave as above. */
  afterApply?: boolean;
  times?: number;
}

export interface FakeFile {
  sha: string;
  content: string;
}

export interface FakePull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  html_url: string;
}

export interface FakeGithub {
  readonly token: string;
  readonly origin: string;
  readonly repo: string;
  /** branch name -> commit sha */
  branches: Map<string, string>;
  /** `${branch}:${path}` -> file */
  files: Map<string, FakeFile>;
  pulls: FakePull[];
  requests: LoggedRequest[];
  fetch: typeof fetch;
  inject(injection: Injection): void;
  /** The commit sha the base branch had when the fake was made. A test compares it after a run. */
  baseSha(): string;
  /** Put a file on a branch before a test (an existing post, for example). */
  seedFile(branch: string, path: string, content: string): FakeFile;
  handle(request: Request): Promise<Response>;
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
const blobSha = (content: string) => sha1(`blob ${Buffer.byteLength(content)}\0${content}`);

export function createFakeGithub(options: { token: string; repo?: string; baseBranch?: string; origin?: string; permissions?: { push: boolean }; archived?: boolean }): FakeGithub {
  const repo = options.repo ?? 'example-owner/example-site';
  const baseBranch = options.baseBranch ?? 'main';
  const origin = (options.origin ?? 'https://fake-github.example.test').replace(/\/$/, '');
  const branches = new Map<string, string>();
  const files = new Map<string, FakeFile>();
  const pulls: FakePull[] = [];
  const requests: LoggedRequest[] = [];
  const injections: (Injection & { left: number })[] = [];
  let commitCounter = 1;
  let prCounter = 1;
  const newCommit = (seed: string) => sha1(`commit ${commitCounter++} ${seed}`);
  const initialBase = newCommit('initial');
  branches.set(baseBranch, initialBase);

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const repoPrefix = `/repos/${repo}`;
  const decode = (text: string) => text.split('/').map(decodeURIComponent).join('/');

  function apply(method: string, path: string, search: URLSearchParams, body: unknown): Response {
    if (!path.startsWith(repoPrefix)) return json(404, { message: 'Not Found' });
    const rest = path.slice(repoPrefix.length);
    if (method === 'GET' && rest === '') {
      return json(200, { full_name: repo, default_branch: baseBranch, private: true, archived: options.archived === true, permissions: { admin: false, push: options.permissions?.push ?? true, pull: true } });
    }
    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (method === 'GET' && ref) {
      const branch = decode(ref[1]!);
      const sha = branches.get(branch);
      if (!sha) return json(404, { message: 'Not Found' });
      return json(200, { ref: `refs/heads/${branch}`, object: { type: 'commit', sha } });
    }
    if (method === 'POST' && rest === '/git/refs') {
      const input = body as { ref?: string; sha?: string } | null;
      const match = /^refs\/heads\/(.+)$/.exec(input?.ref ?? '');
      if (!match || typeof input?.sha !== 'string') return json(422, { message: 'Validation Failed' });
      const branch = match[1]!;
      if (branches.has(branch)) return json(422, { message: 'Reference already exists' });
      if (![...branches.values()].includes(input.sha)) return json(422, { message: 'Object does not exist' });
      branches.set(branch, input.sha);
      // A new branch starts with the files of the commit it was cut from.
      for (const [key, file] of [...files.entries()]) {
        const [from, filePath] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
        if (branches.get(from) === input.sha && from !== branch) files.set(`${branch}:${filePath}`, { ...file });
      }
      return json(201, { ref: input.ref, object: { type: 'commit', sha: input.sha } });
    }
    const contents = /^\/contents\/(.+)$/.exec(rest);
    if (contents && method === 'GET') {
      const filePath = decode(contents[1]!);
      const branch = search.get('ref') ?? baseBranch;
      const file = files.get(`${branch}:${filePath}`);
      if (!file) return json(404, { message: 'Not Found' });
      return json(200, { type: 'file', path: filePath, sha: file.sha, content: Buffer.from(file.content).toString('base64'), encoding: 'base64' });
    }
    if (contents && method === 'PUT') {
      const filePath = decode(contents[1]!);
      const input = body as { message?: string; content?: string; branch?: string; sha?: string } | null;
      const branch = input?.branch ?? baseBranch;
      if (!branches.has(branch)) return json(404, { message: 'Branch not found' });
      if (typeof input?.content !== 'string' || typeof input.message !== 'string') return json(422, { message: 'Invalid request.' });
      const existing = files.get(`${branch}:${filePath}`);
      if (existing && !input.sha) return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      if (existing && input.sha !== existing.sha) return json(409, { message: `${filePath} does not match ${input.sha}` });
      const text = Buffer.from(input.content, 'base64').toString('utf8');
      const file: FakeFile = { sha: blobSha(text), content: text };
      files.set(`${branch}:${filePath}`, file);
      const commit = newCommit(`${branch}:${filePath}`);
      branches.set(branch, commit);
      return json(existing ? 200 : 201, { content: { path: filePath, sha: file.sha, html_url: `${origin}/${repo}/blob/${branch}/${filePath}` }, commit: { sha: commit, html_url: `${origin}/${repo}/commit/${commit}` } });
    }
    if (method === 'POST' && rest === '/pulls') {
      const input = body as { title?: string; head?: string; base?: string; body?: string } | null;
      if (!input?.title || !input.head || !input.base) return json(422, { message: 'Validation Failed' });
      if (!branches.has(input.head) || !branches.has(input.base)) return json(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] });
      if (branches.get(input.head) === branches.get(input.base)) return json(422, { message: 'Validation Failed', errors: [{ message: `No commits between ${input.base} and ${input.head}` }] });
      if (pulls.some((p) => p.head === input.head && p.base === input.base && p.state === 'open')) {
        return json(422, { message: 'Validation Failed', errors: [{ message: `A pull request already exists for ${repo.split('/')[0]}:${input.head}.` }] });
      }
      const number = prCounter++;
      const pull: FakePull = { number, head: input.head, base: input.base, title: input.title, body: input.body ?? '', state: 'open', html_url: `${origin}/${repo}/pull/${number}` };
      pulls.push(pull);
      return json(201, { number, html_url: pull.html_url, state: 'open', title: pull.title });
    }
    if (method === 'GET' && rest === '/pulls') {
      const head = search.get('head') ?? '';
      const branch = head.includes(':') ? head.slice(head.indexOf(':') + 1) : head;
      const state = search.get('state') ?? 'open';
      const found = pulls.filter((p) => (branch ? p.head === branch : true) && (state === 'all' || p.state === state));
      return json(200, found.map((p) => ({ number: p.number, html_url: p.html_url, state: p.state, title: p.title })));
    }
    return json(404, { message: 'Not Found' });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const text = method === 'GET' || method === 'HEAD' ? '' : await request.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const path = url.pathname;
    requests.push({ method, path: path + url.search, headers, body });

    // A page for the owner to open in the manual run: the pull request and its file.
    const page = new RegExp(`^/${repo}/pull/(\\d+)$`).exec(path);
    if (method === 'GET' && page) {
      const pull = pulls.find((p) => p.number === Number(page[1]));
      if (!pull) return new Response('Not found', { status: 404 });
      const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
      const changed = [...files.entries()].filter(([key]) => key.startsWith(`${pull.head}:`) && !files.has(`${pull.base}:${key.slice(pull.head.length + 1)}`));
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>#${pull.number} ${esc(pull.title)}</title><body style="font-family:system-ui;max-width:46rem;margin:2rem auto;padding:0 1rem"><p><strong>Fake GitHub</strong> (local test server). State: <strong>${pull.state.toUpperCase()}</strong></p><h1>${esc(pull.title)} <small>#${pull.number}</small></h1><p>${esc(pull.head)} into ${esc(pull.base)}</p><pre style="white-space:pre-wrap">${esc(pull.body)}</pre>${changed.map(([key, file]) => `<h3>${esc(key.slice(pull.head.length + 1))}</h3><pre style="white-space:pre-wrap;background:#f4f4f4;padding:.75rem">${esc(file.content)}</pre>`).join('')}</body>`,
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }

    const auth = headers.authorization ?? '';
    if (auth !== `Bearer ${options.token}`) return json(401, { message: 'Bad credentials' });

    const injection = injections.find((i) => i.left > 0 && i.match.test(`${method} ${path}`));
    if (injection) {
      injection.left -= 1;
      if (injection.afterApply) apply(method, path, url.searchParams, body);
      if (injection.hang) {
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason));
        });
      }
      if (injection.drop) throw new TypeError('fetch failed', { cause: new Error('socket hang up') });
      if (injection.redirect) return new Response(null, { status: 302, headers: { location: injection.redirect } });
      return typeof injection.body === 'string'
        ? new Response(injection.body, { status: injection.status ?? 500, headers: injection.headers })
        : json(injection.status ?? 500, injection.body ?? { message: 'injected' }, injection.headers);
    }
    return apply(method, path, url.searchParams, body);
  }

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const redirectMode = init?.redirect ?? 'follow';
    const response = await handle(request);
    if (response.status >= 300 && response.status < 400 && redirectMode === 'error') {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    }
    return response;
  }) as typeof fetch;

  return {
    token: options.token,
    origin,
    repo,
    branches,
    files,
    pulls,
    requests,
    fetch: fetchFn,
    inject(injection) {
      injections.push({ ...injection, left: injection.times ?? 1 });
    },
    baseSha: () => initialBase,
    seedFile(branch, path, content) {
      const file: FakeFile = { sha: blobSha(content), content };
      files.set(`${branch}:${path}`, file);
      return file;
    },
    handle,
  };
}

/** The same fake behind a real local HTTP port, for the manual browser run. */
export function serveFakeGithub(fake: FakeGithub, port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = `http://127.0.0.1:${port}${req.url ?? '/'}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const init: RequestInit = { method: req.method ?? 'GET', headers };
      if (chunks.length > 0) init.body = Buffer.concat(chunks);
      fake.handle(new Request(url, init)).then(
        async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        },
        () => {
          res.writeHead(502);
          res.end();
        },
      );
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

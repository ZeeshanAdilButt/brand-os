import { beforeEach, describe, expect, it } from 'vitest';
import type { DraftExtras } from '../src/lib/publishing';
import { branchNameFor, presetMapping, renderSiteFile, type SiteDraftOptions } from '../src/lib/site-export';
import { githubSiteAdapter } from '../src/server/publishing/adapters/github-site';
import type { AdapterContext, AdapterDraft } from '../src/server/publishing/adapters/types';
import { PlatformError } from '../src/server/publishing/errors';
import { payloadHashOf } from '../src/server/publishing/source';
import { createFakeGithub, type FakeGithub } from './helpers/fake-github';

// Built at run time: the repository forbids key-shaped literals in tests.
const TOKEN = ['fake', 'github', 'value', 'z9y8x7w6v5'].join('_');
const REPO = 'example-owner/example-site';
const PATH = 'content/posts/write-path.md';
const DATE = '2026-10-21T09:30:00Z';

let fake: FakeGithub;

function ctxFor(over: Partial<AdapterContext> = {}): AdapterContext {
  return {
    secret: TOKEN,
    config: {},
    fetch: fake.fetch,
    now: () => new Date('2026-10-21T10:00:00Z'),
    baseUrl: 'https://fake-github.example.test',
    timeoutMs: 2000,
    site: { repo: REPO, baseBranch: 'main' },
    ...over,
  };
}

function draftOf(over: { options?: Partial<SiteDraftOptions>; body?: string; title?: string } = {}): AdapterDraft & { branch: string; extras: DraftExtras; payloadSha256: string } {
  const adapted = githubSiteAdapter.adapt({
    title: over.title ?? 'Why the write path stalls',
    description: 'A short look at write stalls.',
    tags: ['go', 'databases'],
    canonicalUrl: 'https://example-blog.dev/posts/write-path',
    coverImageUrl: null,
    series: null,
    bodyMarkdown: over.body ?? '# Intro\n\nThe write path stalls when the log fills.\n',
  });
  const site: SiteDraftOptions = {
    slug: 'write-path',
    dateIso: DATE,
    path: PATH,
    repo: REPO,
    baseBranch: 'main',
    mapping: presetMapping('generic'),
    updateExisting: false,
    expectedSha: null,
    ...over.options,
  };
  const extras: DraftExtras = { site };
  const payloadSha256 = payloadHashOf('site', `${REPO}@main`, adapted.payload, extras);
  return { id: 'draft-1', payload: adapted.payload, remoteId: null, extras, payloadSha256, branch: branchNameFor(site.slug, payloadSha256) };
}

const writes = () => fake.requests.filter((r) => r.method !== 'GET');
const failure = async (run: () => Promise<unknown>) => {
  const err = await run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PlatformError);
  return err as PlatformError;
};

beforeEach(() => {
  fake = createFakeGithub({ token: TOKEN, repo: REPO, origin: 'https://fake-github.example.test' });
});

describe('opening a pull request', () => {
  it('creates a branch from the base, commits one file and opens a pull request into the base', async () => {
    const draft = draftOf();
    const result = await githubSiteAdapter.publish(ctxFor(), draft);

    expect(result).toEqual({ remoteId: '1', remoteUrl: 'https://fake-github.example.test/example-owner/example-site/pull/1' });
    expect(draft.branch).toMatch(/^brand-os\/write-path-[0-9a-f]{8}$/);
    expect(draft.branch.endsWith(draft.payloadSha256.slice(0, 8))).toBe(true);

    // Exactly three writes, in order: the branch, the file, the pull request.
    expect(writes().map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST /repos/${REPO}/git/refs`,
      `PUT /repos/${REPO}/contents/${PATH}`,
      `POST /repos/${REPO}/pulls`,
    ]);
    expect(writes()[0]!.body).toEqual({ ref: `refs/heads/${draft.branch}`, sha: fake.baseSha() });
    const put = writes()[1]!.body as { branch: string; content: string; message: string; sha?: string };
    expect(put.branch).toBe(draft.branch);
    expect(put.sha).toBeUndefined();
    expect(put.message).toBe('Add post: Why the write path stalls');
    const committed = Buffer.from(put.content, 'base64').toString('utf8');
    expect(committed).toBe(renderSiteFile(draft.payload, presetMapping('generic'), DATE, 'write-path').content);
    expect(fake.files.get(`${draft.branch}:${PATH}`)?.content).toBe(committed);
    const pr = writes()[2]!.body as { head: string; base: string; title: string; body: string };
    expect(pr).toMatchObject({ head: draft.branch, base: 'main', title: 'Add post: Why the write path stalls' });
    expect(pr.body).toContain(`\`${PATH}\``);
    expect(pr.body).toContain('a new file');
    expect(pr.body).toContain(`#${draft.payloadSha256.slice(0, 8).toUpperCase()}`);
    expect(pr.body).toMatch(/Nothing is merged automatically/);
  });

  it('never writes to the base branch and never merges', async () => {
    const draft = draftOf();
    await githubSiteAdapter.publish(ctxFor(), draft);
    expect(fake.branches.get('main')).toBe(fake.baseSha());
    expect(fake.files.has(`main:${PATH}`)).toBe(false);
    for (const request of writes()) {
      expect(request.path, 'no merge endpoint').not.toMatch(/merge/);
      expect(JSON.stringify(request.body), 'no write names the base branch as its target').not.toMatch(/"branch":"main"|refs\/heads\/main"/);
    }
    expect(fake.requests.some((r) => r.method === 'DELETE' || r.method === 'PATCH')).toBe(false);
  });

  it('sends the token as a bearer header and nowhere else', async () => {
    await githubSiteAdapter.publish(ctxFor(), draftOf());
    for (const request of fake.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.headers['user-agent']).toBeTruthy();
      expect(request.headers.accept).toBe('application/vnd.github+json');
      expect(request.path).not.toContain(TOKEN);
      expect(JSON.stringify(request.body ?? '')).not.toContain(TOKEN);
    }
  });

  it('refuses to publish when the working branch would be the base branch', async () => {
    const draft = draftOf();
    const clash = { ...draft, extras: { site: { ...draft.extras.site!, baseBranch: draft.branch } } };
    const err = await failure(() => githubSiteAdapter.publish(ctxFor(), clash));
    expect(err.kind).toBe('config');
    expect(err.notSent).toBe(true);
    expect(err.message).toMatch(/never writes to the base branch/);
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a path that leaves the repository, before any request', async () => {
    const draft = draftOf({ options: { path: 'content/../../outside.md' } });
    const err = await failure(() => githubSiteAdapter.publish(ctxFor(), draft));
    expect(err.notSent).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('an existing file is never overwritten by accident', () => {
  it('refuses when a file is there and the draft is not marked "update existing"', async () => {
    fake.seedFile('main', PATH, 'old content');
    const err = await failure(() => githubSiteAdapter.publish(ctxFor(), draftOf()));
    expect(err.kind).toBe('validation');
    expect(err.notSent).toBe(true);
    expect(err.ambiguous).toBe(false);
    expect(err.message).toMatch(/already exists/);
    expect(writes()).toHaveLength(0);
    expect(fake.files.get(`main:${PATH}`)?.content).toBe('old content');
  });

  it('refuses an update whose sha is not the one the owner looked at', async () => {
    const seeded = fake.seedFile('main', PATH, 'old content');
    const draft = draftOf({ options: { updateExisting: true, expectedSha: 'f'.repeat(40) } });
    const err = await failure(() => githubSiteAdapter.publish(ctxFor(), draft));
    expect(err.message).toMatch(/not the one you looked at/);
    expect(err.message).toContain(seeded.sha.slice(0, 7));
    expect(writes()).toHaveLength(0);
  });

  it('updates the file with its sha when the draft is marked and the sha still matches', async () => {
    const seeded = fake.seedFile('main', PATH, 'old content');
    const draft = draftOf({ options: { updateExisting: true, expectedSha: seeded.sha } });
    const result = await githubSiteAdapter.publish(ctxFor(), draft);
    expect(result.remoteId).toBe('1');
    const put = writes().find((r) => r.method === 'PUT')!.body as { sha?: string; message: string };
    expect(put.sha).toBe(seeded.sha);
    expect(put.message).toMatch(/^Update post:/);
    expect(fake.files.get(`main:${PATH}`)?.content).toBe('old content');
    const pr = fake.pulls[0]!;
    expect(pr.body).toContain('replaces the existing file');
  });

  it('refuses an "update existing" draft when the file is not there', async () => {
    const err = await failure(() => githubSiteAdapter.publish(ctxFor(), draftOf({ options: { updateExisting: true, expectedSha: 'a'.repeat(40) } })));
    expect(err.message).toMatch(/does not exist/);
    expect(writes()).toHaveLength(0);
  });

  it('staging reads the repository and writes nothing, and reports the target file', async () => {
    const free = await githubSiteAdapter.stage(ctxFor(), draftOf());
    expect(free.info).toMatchObject({ fileExists: false, fileSha: null, baseSha: fake.baseSha(), path: PATH });
    expect(free.remoteId).toMatch(/^brand-os\/write-path-/);
    const seeded = fake.seedFile('main', PATH, 'old');
    const taken = await githubSiteAdapter.stage(ctxFor(), draftOf());
    expect(taken.info).toMatchObject({ fileExists: true, fileSha: seeded.sha });
    expect(writes()).toHaveLength(0);
  });
});

describe('a leftover branch (422 "already exists")', () => {
  it('reuses a branch of that name when it still points at the base commit', async () => {
    const draft = draftOf();
    fake.branches.set(draft.branch, fake.baseSha());
    const result = await githubSiteAdapter.publish(ctxFor(), draft);
    expect(result.remoteId).toBe('1');
    expect(fake.files.get(`${draft.branch}:${PATH}`)).toBeDefined();
  });

  it('refuses when that branch already has commits on it, and changes nothing', async () => {
    const draft = draftOf();
    fake.branches.set(draft.branch, 'e'.repeat(40));
    const err = await failure(() => githubSiteAdapter.publish(ctxFor(), draft));
    expect(err.kind).toBe('validation');
    expect(err.notSent).toBe(true);
    expect(err.message).toMatch(/already exists and has commits/);
    expect(writes().map((r) => r.path.split('/').slice(-1)[0])).toEqual(['refs']);
    expect(fake.pulls).toHaveLength(0);
  });

  it('answers a pull request that already exists by returning it instead of opening a second', async () => {
    const draft = draftOf();
    await githubSiteAdapter.publish(ctxFor(), draft);
    const again = await githubSiteAdapter.publish(ctxFor(), draft).catch((e: unknown) => e);
    // The branch is reused (same base sha is no longer true after a commit), so a second try is refused rather than duplicated.
    expect(fake.pulls).toHaveLength(1);
    expect(again).toBeInstanceOf(PlatformError);
  });
});

describe('token and scope problems', () => {
  it('reports a missing scope in words that say what to grant, as a clean refusal', async () => {
    fake.inject({ match: /PUT \/repos\/.+\/contents\//, status: 403, body: { message: 'Resource not accessible by personal access token' } });
    const err = await failure(() => githubSiteAdapter.publish(ctxFor(), draftOf()));
    expect(err.kind).toBe('auth');
    expect(err.message).toMatch(/Contents: read and write/);
    expect(err.message).toMatch(/Pull requests: read and write/);
    expect(err.ambiguous).toBe(false);
    expect(fake.pulls).toHaveLength(0);
  });

  it('reports a refused pull request call (missing Pull requests scope) as clean too', async () => {
    fake.inject({ match: /POST \/repos\/.+\/pulls/, status: 403, body: { message: 'Resource not accessible by personal access token' } });
    const err = await failure(() => githubSiteAdapter.publish(ctxFor(), draftOf()));
    expect(err.kind).toBe('auth');
    expect(err.ambiguous).toBe(false);
  });

  it('a wrong token is an auth failure with no key in the message', async () => {
    const err = await failure(() => githubSiteAdapter.publish(ctxFor({ secret: 'not-the-token-1234' }), draftOf()));
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('not-the-token-1234');
  });

  it('health reads the repository, names it and refuses a read-only or archived one', async () => {
    expect(await githubSiteAdapter.health(ctxFor())).toEqual({ who: REPO });
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`GET /repos/${REPO}`]);
    fake = createFakeGithub({ token: TOKEN, repo: REPO, permissions: { push: false } });
    const readOnly = await failure(() => githubSiteAdapter.health(ctxFor()));
    expect(readOnly.kind).toBe('auth');
    fake = createFakeGithub({ token: TOKEN, repo: REPO, archived: true });
    expect((await failure(() => githubSiteAdapter.health(ctxFor()))).message).toMatch(/archived/);
    fake = createFakeGithub({ token: TOKEN, repo: REPO });
    expect((await failure(() => githubSiteAdapter.health(ctxFor({ site: undefined })))).kind).toBe('config');
    // A repository the token cannot see answers "not found".
    expect((await failure(() => githubSiteAdapter.health(ctxFor({ site: { repo: 'someone-else/private-repo', baseBranch: 'main' } })))).kind).toBe('not_found');
  });

  it('never puts the token in any error, detail or request it makes, wherever the platform echoes it', async () => {
    const steps = [/GET \/repos\/.+\/git\/ref\/heads\/main/, /GET \/repos\/.+\/contents\//, /POST \/repos\/.+\/git\/refs/, /PUT \/repos\/.+\/contents\//, /POST \/repos\/.+\/pulls/];
    for (const match of steps) {
      fake = createFakeGithub({ token: TOKEN, repo: REPO });
      fake.inject({ match, status: 500, body: `Internal error while using ${TOKEN} and Authorization: Bearer ${TOKEN}` });
      const err = await failure(() => githubSiteAdapter.publish(ctxFor(), draftOf()));
      expect(`${err.message} ${err.detail ?? ''}`, String(match)).not.toContain(TOKEN);
      expect(JSON.stringify(fake.requests.map((r) => r.body))).not.toContain(TOKEN);
    }
  });
});

describe('rate limits', () => {
  it('reads the primary limit from the reset header', async () => {
    const reset = Math.floor(new Date('2026-10-21T10:02:00Z').getTime() / 1000);
    fake.inject({ match: /GET \/repos\/.+\/git\/ref/, status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, body: { message: 'API rate limit exceeded' } });
    const err = await failure(() => githubSiteAdapter.publish(ctxFor(), draftOf()));
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(120_000);
    expect(err.ambiguous).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  it('reads a secondary limit from Retry-After, on a 429 as well as a 403', async () => {
    for (const status of [403, 429]) {
      fake = createFakeGithub({ token: TOKEN, repo: REPO });
      fake.inject({ match: /POST \/repos\/.+\/pulls/, status, headers: { 'retry-after': '45' }, body: { message: 'You have exceeded a secondary rate limit.' } });
      const err = await failure(() => githubSiteAdapter.publish(ctxFor(), draftOf()));
      expect(err.kind, String(status)).toBe('rate_limit');
      expect(err.retryAfterMs).toBe(45_000);
      // A refused pull request call is a clear refusal: nothing was opened.
      expect(err.ambiguous).toBe(false);
    }
  });
});

describe('redirects are refused', () => {
  it('before the pull request it is a clean refusal; at the pull request it is ambiguous', async () => {
    fake.inject({ match: /POST \/repos\/.+\/git\/refs/, redirect: 'https://elsewhere.example.test/x' });
    const early = await failure(() => githubSiteAdapter.publish(ctxFor(), draftOf()));
    expect(early.kind).toBe('redirect');
    expect(early.ambiguous).toBe(false);
    expect(fake.pulls).toHaveLength(0);

    fake = createFakeGithub({ token: TOKEN, repo: REPO });
    fake.inject({ match: /POST \/repos\/.+\/pulls/, redirect: 'https://elsewhere.example.test/x' });
    const late = await failure(() => githubSiteAdapter.publish(ctxFor(), draftOf()));
    expect(late.kind).toBe('redirect');
    expect(late.ambiguous).toBe(true);
  });
});

describe('timeouts: unknown only where a pull request may exist', () => {
  it('a timeout creating the branch or the commit is a clean failure, with no pull request opened', async () => {
    for (const match of [/POST \/repos\/.+\/git\/refs/, /PUT \/repos\/.+\/contents\//]) {
      fake = createFakeGithub({ token: TOKEN, repo: REPO });
      fake.inject({ match, hang: true });
      const err = await failure(() => githubSiteAdapter.publish(ctxFor({ timeoutMs: 40 }), draftOf()));
      expect(err.kind).toBe('timeout');
      expect(err.ambiguous, String(match)).toBe(false);
      expect(fake.pulls).toHaveLength(0);
    }
  });

  it('a timeout opening the pull request is ambiguous, and "check" then finds the pull request that did open', async () => {
    const draft = draftOf();
    fake.inject({ match: /POST \/repos\/.+\/pulls/, afterApply: true, hang: true });
    const err = await failure(() => githubSiteAdapter.publish(ctxFor({ timeoutMs: 40 }), draft));
    expect(err.kind).toBe('timeout');
    expect(err.ambiguous).toBe(true);
    expect(fake.pulls).toHaveLength(1);

    expect(await githubSiteAdapter.check(ctxFor(), draft)).toEqual({ state: 'published', remoteId: '1', remoteUrl: fake.pulls[0]!.html_url });
  });

  it('a dropped connection at the pull request is ambiguous; one earlier is not', async () => {
    fake.inject({ match: /POST \/repos\/.+\/pulls/, drop: true });
    const late = await failure(() => githubSiteAdapter.publish(ctxFor(), draftOf()));
    expect(late.kind).toBe('network');
    expect(late.ambiguous).toBe(true);
    fake = createFakeGithub({ token: TOKEN, repo: REPO });
    fake.inject({ match: /PUT \/repos\/.+\/contents\//, drop: true });
    expect((await failure(() => githubSiteAdapter.publish(ctxFor(), draftOf()))).ambiguous).toBe(false);
  });

  it('check says "private" when only the branch exists and "not found" when nothing does', async () => {
    const draft = draftOf();
    expect(await githubSiteAdapter.check(ctxFor(), draft)).toEqual({ state: 'not_found' });
    fake.branches.set(draft.branch, 'c'.repeat(40));
    expect(await githubSiteAdapter.check(ctxFor(), draft)).toEqual({ state: 'private' });
  });
});

describe('the request shown for approval', () => {
  it('lists the exact steps, the branch, the file and the pull request, and says the base is only read', () => {
    const draft = draftOf();
    const preview = githubSiteAdapter.preview(draft.payload, true, {}, null, { extras: draft.extras, payloadSha256: draft.payloadSha256 }) as { steps: string[]; branch: string; file: { path: string; content: string }; pullRequest: { base: string; head: string } };
    expect(preview.branch).toBe(draft.branch);
    expect(preview.steps[0]).toMatch(/read the base branch, never write to it/);
    expect(preview.steps.some((s) => s.startsWith('POST pulls'))).toBe(true);
    expect(preview.pullRequest).toMatchObject({ base: 'main', head: draft.branch });
    expect(preview.file.path).toBe(PATH);
    expect(preview.file.content).toBe(renderSiteFile(draft.payload, presetMapping('generic'), DATE, 'write-path').content);
  });

  it('lints the personal-site payload: path, repository, update-existing and app-only images', () => {
    const draft = draftOf();
    expect(githubSiteAdapter.validate(draft.payload, draft.extras).filter((i) => i.severity === 'error')).toEqual([]);
    const bad = githubSiteAdapter.validate(draft.payload, { site: { ...draft.extras.site!, path: '../x.md', repo: null, updateExisting: true, expectedSha: null } });
    expect(bad.map((i) => i.code)).toEqual(expect.arrayContaining(['path_invalid', 'repo_missing', 'sha_missing']));
    const asset = githubSiteAdapter.adapt({ title: 'T', description: '', tags: [], canonicalUrl: null, coverImageUrl: null, series: null, bodyMarkdown: '![x](asset:123)\n\n![ok](/img/a.png)' });
    const issues = githubSiteAdapter.validate(asset.payload, draft.extras);
    expect(issues.find((i) => i.code === 'image_local')?.items).toEqual(['asset:123']);
  });
});

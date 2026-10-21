import { PLATFORMS } from '../../../lib/catalog';
import type { DraftExtras, DraftPayload, LintIssue } from '../../../lib/publishing';
import { branchNameFor, isSafeBranch, mdxHazards, parseRepo, renderSiteFile, validateRepoPath, type SiteDraftOptions } from '../../../lib/site-export';
import { PlatformError } from '../errors';
import { failureFor, parseObject, parseRetryAfter, send, type HttpResult, type RequestOptions } from '../http';
import { analyzeBody } from '../lint';
import { contentAdapter } from './content';
import type { AdapterContext, AdapterDraft, CheckResult, HealthResult, PlatformAdapter, PublishResult, StageResult } from './types';

/**
 * The personal site through the GitHub REST API (checked against docs.github.com, see INTEGRATIONS.md).
 *
 * It only ever does this, in order: read the base branch's sha, read the target file on the base branch, create a
 * NEW branch `brand-os/<slug>-<first 8 of the payload hash>` at that sha, commit ONE file to that branch, and open
 * a pull request from it into the base branch. It never writes to the base branch, never merges, and refuses
 * to replace an existing file unless the draft says so and the file's blob sha is the one the owner saw.
 *
 * Until the pull request call, nothing is visible on the site, so a failure before it is a clean refusal (the
 * worst case is a stray branch). The pull request call is the one that can be ambiguous: a timeout there is
 * `unknown`, and "Check on platform" looks for a pull request from the branch.
 */

export const GITHUB_DEFAULT_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'BrandOS-Publisher/1.0';

type Json = Record<string, unknown>;

function requestOptions(ctx: AdapterContext): RequestOptions {
  return { fetch: ctx.fetch, timeoutMs: ctx.timeoutMs, secrets: [ctx.secret], now: ctx.now };
}

function call(ctx: AdapterContext, method: string, path: string, body?: unknown): Promise<HttpResult> {
  return send(requestOptions(ctx), `${ctx.baseUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.secret}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': USER_AGENT,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Classify a non-2xx GitHub answer, with GitHub's own conventions for rate limits and token scope. */
function failure(ctx: AdapterContext, res: HttpResult, what: string): PlatformError {
  const base = failureFor('GitHub', res, requestOptions(ctx));
  const text = res.text.toLowerCase();
  const remaining = res.headers.get('x-ratelimit-remaining');
  if ((res.status === 403 || res.status === 429) && (remaining === '0' || text.includes('rate limit') || res.headers.get('retry-after'))) {
    const retry = parseRetryAfter(res.headers.get('retry-after'), ctx.now());
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const wait = retry ?? (Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - ctx.now().getTime()) : 60_000);
    return new PlatformError('rate_limit', 'GitHub is rate limiting requests. Wait a little and try again.', { httpStatus: res.status, retryAfterMs: wait, detail: base.detail });
  }
  if (res.status === 403 && /resource not accessible|must have push access|not accessible by/.test(text)) {
    return new PlatformError('auth', 'GitHub refused: the token cannot do this on the repository. It needs Contents: read and write and Pull requests: read and write for that one repository.', { httpStatus: 403, detail: base.detail });
  }
  if (res.status === 401) return new PlatformError('auth', 'GitHub did not accept the token. Make a new one in GitHub and replace it in Settings.', { httpStatus: 401 });
  if (res.status === 404) {
    return new PlatformError('not_found', `GitHub could not find ${what}. Check the repository name and branch, and that the token can see the repository (a token without access gets "not found").`, { httpStatus: 404, detail: base.detail });
  }
  return base;
}

function expectOk(ctx: AdapterContext, res: HttpResult, what: string): HttpResult {
  if (res.ok) return res;
  throw failure(ctx, res, what);
}

const seg = (path: string) => path.split('/').map(encodeURIComponent).join('/');

interface Plan {
  owner: string;
  name: string;
  repo: string;
  base: string;
  branch: string;
  path: string;
  options: SiteDraftOptions;
  file: string;
  title: string;
}

function planFor(draft: AdapterDraft): Plan {
  const options = draft.extras?.site;
  if (!options) throw new PlatformError('config', 'This draft has no personal-site options. Rebuild it.', { notSent: true });
  const parsed = options.repo ? parseRepo(options.repo) : null;
  if (!parsed) throw new PlatformError('config', 'No repository is set. Add owner/name in Settings > Connections.', { notSent: true });
  if (!isSafeBranch(options.baseBranch)) throw new PlatformError('config', 'The base branch name is not valid.', { notSent: true });
  const path = validateRepoPath(options.path);
  if (!path.ok) throw new PlatformError('config', path.reason, { notSent: true });
  if (!draft.payloadSha256) throw new PlatformError('config', 'This draft has no payload hash. Rebuild it.', { notSent: true });
  const branch = branchNameFor(options.slug, draft.payloadSha256);
  if (!isSafeBranch(branch)) throw new PlatformError('config', 'The branch name for this post is not valid.', { notSent: true });
  // The one rule that keeps the base branch untouchable: the working branch can never be the base branch.
  if (branch === options.baseBranch) throw new PlatformError('config', 'The pull request branch would be the base branch. Refusing: this app never writes to the base branch.', { notSent: true });
  const file = renderSiteFile(draft.payload, options.mapping, options.dateIso, options.slug).content;
  return { owner: parsed.owner, name: parsed.name, repo: options.repo!, base: options.baseBranch, branch, path: options.path, options, file, title: draft.payload.title };
}

const repoPath = (plan: Plan) => `/repos/${encodeURIComponent(plan.owner)}/${encodeURIComponent(plan.name)}`;

async function readRef(ctx: AdapterContext, plan: Plan, branch: string): Promise<string | null> {
  const res = await call(ctx, 'GET', `${repoPath(plan)}/git/ref/heads/${seg(branch)}`);
  if (res.status === 404) return null;
  expectOk(ctx, res, `the branch ${branch}`);
  const sha = ((parseObject(res.text)?.object as Json | undefined)?.sha ?? null) as unknown;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) throw new PlatformError('protocol', 'GitHub answered a branch lookup without a commit sha.', { httpStatus: res.status });
  return sha;
}

async function readFile(ctx: AdapterContext, plan: Plan): Promise<{ sha: string } | null> {
  const res = await call(ctx, 'GET', `${repoPath(plan)}/contents/${seg(plan.path)}?ref=${encodeURIComponent(plan.base)}`);
  if (res.status === 404) return null;
  expectOk(ctx, res, `the file ${plan.path}`);
  let value: unknown;
  try {
    value = JSON.parse(res.text);
  } catch {
    throw new PlatformError('protocol', 'GitHub answered a file lookup with something that is not JSON.', { httpStatus: res.status });
  }
  if (Array.isArray(value)) throw new PlatformError('validation', `${plan.path} is a folder in the repository, not a file.`, { notSent: true });
  const sha = (value as Json | null)?.sha;
  if (typeof sha !== 'string') throw new PlatformError('protocol', 'GitHub answered a file lookup without a sha.', { httpStatus: res.status });
  return { sha };
}

/** The rule about existing files, in one place: used when staging (to tell the owner) and when publishing (to enforce). */
function checkTarget(plan: Plan, existing: { sha: string } | null): void {
  if (existing && !plan.options.updateExisting) {
    throw new PlatformError('validation', `A file already exists at ${plan.path} (blob ${existing.sha.slice(0, 7)}). Nothing was changed. Mark this draft “update existing” if you mean to replace it, or change the path.`, { notSent: true });
  }
  if (existing && plan.options.updateExisting && plan.options.expectedSha !== existing.sha) {
    throw new PlatformError('validation', `The file at ${plan.path} is not the one you looked at (it is blob ${existing.sha.slice(0, 7)} now). Nothing was changed. Stage the draft again to look at it.`, { notSent: true });
  }
  if (!existing && plan.options.updateExisting) {
    throw new PlatformError('validation', `${plan.path} does not exist on ${plan.base}, but this draft is marked “update existing”. Nothing was changed.`, { notSent: true });
  }
}

const notSent = (err: unknown): never => {
  throw err instanceof PlatformError ? err.asNotSent() : err;
};

function prBody(plan: Plan, draft: AdapterDraft, existing: { sha: string } | null): string {
  const tag = `#${(draft.payloadSha256 ?? '').slice(0, 8).toUpperCase()}`;
  return [
    'This pull request was opened by Brand OS after the owner approved this exact change.',
    '',
    `- File: \`${plan.path}\` (${existing ? `replaces the existing file, blob \`${existing.sha.slice(0, 7)}\`` : 'a new file'})`,
    `- Title: ${plan.title}`,
    `- Payload: ${tag}`,
    `- Base branch: \`${plan.base}\``,
    '',
    'Nothing is merged automatically. Review the diff in GitHub and merge it when you want the post to go live.',
  ].join('\n');
}

export function githubPreview(payload: DraftPayload, extras: DraftExtras, payloadSha256: string) {
  const options = extras.site;
  if (!options) return { note: 'No personal-site options on this draft yet.' };
  const branch = branchNameFor(options.slug, payloadSha256);
  const file = renderSiteFile(payload, options.mapping, options.dateIso, options.slug).content;
  const commitMessage = `${options.updateExisting ? 'Update' : 'Add'} post: ${payload.title}`;
  return {
    repository: options.repo,
    steps: [
      `GET  git/ref/heads/${options.baseBranch}  (read the base branch, never write to it)`,
      `GET  contents/${options.path}?ref=${options.baseBranch}  (${options.updateExisting ? `must still be blob ${options.expectedSha?.slice(0, 7) ?? '?'}` : 'must not exist'})`,
      `POST git/refs  { ref: "refs/heads/${branch}", sha: <base sha> }`,
      `PUT  contents/${options.path}  { branch: "${branch}", message: "${commitMessage}"${options.updateExisting ? `, sha: "${options.expectedSha ?? ''}"` : ''} }`,
      `POST pulls  { head: "${branch}", base: "${options.baseBranch}", title: "${commitMessage}" }`,
    ],
    branch,
    pullRequest: { title: commitMessage, head: branch, base: options.baseBranch },
    file: { path: options.path, content: file },
  };
}

const base = contentAdapter('site');

export const githubSiteAdapter: PlatformAdapter = {
  id: 'site',
  info: PLATFORMS.site,

  adapt: base.adapt,
  tags: base.tags,

  validate(payload: DraftPayload, extras: DraftExtras = {}): LintIssue[] {
    const issues: LintIssue[] = [];
    if (!payload.title.trim()) issues.push({ code: 'title_empty', severity: 'error', message: 'The title is empty. Give the article a title.' });
    if (!payload.bodyMarkdown.trim()) issues.push({ code: 'body_empty', severity: 'error', message: 'The article has no text.' });
    if (payload.coverImageUrl && !/^(https:\/\/|\/)/i.test(payload.coverImageUrl)) {
      issues.push({ code: 'cover_not_public', severity: 'error', message: 'The cover must be an https address or a path on your site that starts with /.', items: [payload.coverImageUrl] });
    }
    const found = analyzeBody(payload.bodyMarkdown);
    const appOnly = found.localImages.filter((url) => /^asset:/i.test(url));
    if (appOnly.length > 0) {
      issues.push({ code: 'image_local', severity: 'error', message: 'These images only exist inside this app and would be broken on your site. Replace them with a path in your repository or a public address.', items: appOnly });
    }
    const site = extras.site;
    if (!site) {
      issues.push({ code: 'site_options', severity: 'error', message: 'The personal-site options are missing. Rebuild the draft.' });
      return issues;
    }
    const path = validateRepoPath(site.path);
    if (!path.ok) issues.push({ code: 'path_invalid', severity: 'error', message: path.reason, items: [site.path] });
    if (!site.repo || !parseRepo(site.repo)) {
      issues.push({ code: 'repo_missing', severity: 'error', message: 'No repository is set, so a pull request cannot be opened. Markdown export and posting by hand still work. Set owner/name in Settings > Connections.' });
    }
    if (site.updateExisting && !site.expectedSha) {
      issues.push({ code: 'sha_missing', severity: 'error', message: 'This draft is marked “update existing” but no file has been looked at yet. Stage the draft to read the file, then mark it.' });
    }
    if (site.mapping.extension === 'mdx') {
      const hazards = mdxHazards(payload.bodyMarkdown);
      if (hazards.length > 0) issues.push({ code: 'mdx_hazard', severity: 'warning', message: 'This body may not compile as MDX.', items: hazards });
    }
    if (!payload.canonicalUrl) {
      issues.push({ code: 'canonical_missing', severity: 'warning', message: 'No canonical URL is set. Copies on other platforms will have nothing to point back to.' });
    }
    return issues;
  },

  preview(payload, _published, _config, _remoteId, info) {
    return githubPreview(payload, info?.extras ?? {}, info?.payloadSha256 ?? '00000000');
  },

  async health(ctx): Promise<HealthResult> {
    const target = ctx.site ? parseRepo(ctx.site.repo) : null;
    if (!target) throw new PlatformError('config', 'Save the repository (owner/name) first, then connect the token.', { notSent: true });
    const res = expectOk(ctx, await call(ctx, 'GET', `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`), `the repository ${ctx.site!.repo}`);
    const repo = parseObject(res.text);
    const fullName = repo?.full_name;
    if (typeof fullName !== 'string') throw new PlatformError('protocol', 'GitHub answered, but did not describe the repository.', { httpStatus: res.status });
    const permissions = repo?.permissions as Json | undefined;
    if (permissions && permissions.push === false) {
      throw new PlatformError('auth', `The token can read ${fullName} but cannot write to it. It needs Contents: read and write and Pull requests: read and write for this repository.`, { httpStatus: res.status });
    }
    if (repo?.archived === true) throw new PlatformError('validation', `${fullName} is archived, so nothing can be written to it.`);
    return { who: fullName };
  },

  /** Read-only: the base branch, and whether the target file exists. Nothing is written. */
  async stage(ctx, draft): Promise<StageResult> {
    const plan = planFor(draft);
    const baseSha = await readRef(ctx, plan, plan.base);
    if (!baseSha) throw new PlatformError('config', `The base branch ${plan.base} does not exist in ${plan.repo}.`, { notSent: true });
    const existing = await readFile(ctx, plan);
    return { remoteId: plan.branch, previewUrl: null, info: { baseSha, fileExists: existing !== null, fileSha: existing?.sha ?? null, branch: plan.branch, path: plan.path } };
  },

  async publish(ctx, draft): Promise<PublishResult> {
    const plan = planFor(draft);
    let existing: { sha: string } | null;
    let baseSha: string | null;
    try {
      baseSha = await readRef(ctx, plan, plan.base);
      if (!baseSha) throw new PlatformError('config', `The base branch ${plan.base} does not exist in ${plan.repo}.`, { notSent: true });
      existing = await readFile(ctx, plan);
      checkTarget(plan, existing);

      // A new branch from the base sha. If a branch of this name is left over from an earlier try and still
      // points at the base sha (nothing was committed to it), it is reused; anything else is refused.
      const created = await call(ctx, 'POST', `${repoPath(plan)}/git/refs`, { ref: `refs/heads/${plan.branch}`, sha: baseSha });
      if (!created.ok) {
        if (created.status === 422 && /already exists/i.test(created.text)) {
          const tip = await readRef(ctx, plan, plan.branch);
          if (tip !== baseSha) {
            throw new PlatformError('validation', `The branch ${plan.branch} already exists and has commits on it. Delete it in GitHub, or change the post so it gets a new branch name. Nothing was changed.`, { httpStatus: 422, notSent: true });
          }
        } else {
          throw failure(ctx, created, `the branch ${plan.branch}`);
        }
      }

      const message = `${plan.options.updateExisting ? 'Update' : 'Add'} post: ${plan.title}`;
      const committed = await call(ctx, 'PUT', `${repoPath(plan)}/contents/${seg(plan.path)}`, {
        message,
        content: Buffer.from(plan.file, 'utf8').toString('base64'),
        branch: plan.branch,
        ...(existing ? { sha: existing.sha } : {}),
      });
      if (!committed.ok) throw failure(ctx, committed, `the file ${plan.path}`);
    } catch (err) {
      return notSent(err);
    }

    // The pull request: the one step whose failure can be ambiguous.
    const title = `${plan.options.updateExisting ? 'Update' : 'Add'} post: ${plan.title}`;
    const opened = await call(ctx, 'POST', `${repoPath(plan)}/pulls`, { title, head: plan.branch, base: plan.base, body: prBody(plan, draft, existing), maintainer_can_modify: false });
    if (!opened.ok) {
      if (opened.status === 422 && /already exists/i.test(opened.text)) {
        const found = await findPull(ctx, plan);
        if (found) return found;
      }
      throw failure(ctx, opened, 'the pull request');
    }
    const pr = parseObject(opened.text);
    if (!pr || typeof pr.html_url !== 'string' || typeof pr.number !== 'number') {
      throw new PlatformError('protocol', 'GitHub accepted the request but its answer could not be read. The pull request may exist.', { httpStatus: opened.status });
    }
    return { remoteId: String(pr.number), remoteUrl: pr.html_url };
  },

  async check(ctx, draft): Promise<CheckResult> {
    const plan = planFor(draft);
    const found = await findPull(ctx, plan);
    if (found) return { state: 'published', remoteId: found.remoteId, remoteUrl: found.remoteUrl };
    if (await readRef(ctx, plan, plan.branch)) return { state: 'private' };
    return { state: 'not_found' };
  },
};

/** A pull request from this plan's branch into the base, open or closed. */
async function findPull(ctx: AdapterContext, plan: Plan): Promise<PublishResult | null> {
  const query = `head=${encodeURIComponent(`${plan.owner}:${plan.branch}`)}&base=${encodeURIComponent(plan.base)}&state=all&per_page=5`;
  const res = expectOk(ctx, await call(ctx, 'GET', `${repoPath(plan)}/pulls?${query}`), 'the pull requests');
  let list: unknown;
  try {
    list = JSON.parse(res.text);
  } catch {
    throw new PlatformError('protocol', 'GitHub answered a pull request lookup with something that is not JSON.', { httpStatus: res.status });
  }
  if (!Array.isArray(list)) throw new PlatformError('protocol', 'GitHub answered a pull request lookup with an unexpected shape.', { httpStatus: res.status });
  const hit = list.find((item): item is Json => typeof item === 'object' && item !== null && typeof (item as Json).html_url === 'string');
  return hit ? { remoteId: String(hit.number), remoteUrl: hit.html_url as string } : null;
}

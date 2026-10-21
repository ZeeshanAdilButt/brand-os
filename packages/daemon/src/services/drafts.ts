import { randomUUID } from 'node:crypto';
import {
  createDevtoTransform,
  createLinkedinTransform,
  type Authorship,
  type ContentItem,
  type Draft,
  type DraftKind,
  type DraftStatus,
  type LintResult,
  type PlatformId,
  type RouteKind,
  type Transform,
} from '@cph/core';
import { z } from 'zod';
import { errorText, type Audit } from '../audit.js';
import type { Config } from '../config.js';
import type { DraftFilter, Repos } from '../db/repos.js';
import { recomputeHash, type LintDraft } from '../gate/prechecks.js';
import { ALREADY_OUT } from '../gate/statuses.js';
import type { Notifier } from '../notify.js';
import { activeRouteKind, type RouteRegistry } from '../routes/registry.js';
import type { RemoteRef } from '../routes/types.js';

/** The platforms Phase 0 can draft for. */
export type DraftPlatform = 'devto' | 'linkedin';
const DRAFT_PLATFORMS: ReadonlySet<string> = new Set<DraftPlatform>(['devto', 'linkedin']);

/** dev.to waits this long after T0 so the original is indexed first (spec 5.2). */
export const DEVTO_DELAY_MS = 48 * 60 * 60 * 1000;

export type DraftErrorCode =
  | 'unknown-draft'
  | 'unknown-post'
  | 'unsupported-platform'
  | 'invalid-payload'
  | 'full-text-immutable'
  | 'canonical-not-live'
  | 'not-editable'
  | 'conflict'
  | 'no-stage'
  | 'not-stageable'
  | 'no-remote-schedule'
  | 'no-route'
  | 'not-staged'
  | 'assist-route'
  | 'inactive-route'
  | 'not-handed-off'
  | 'not-unknown'
  | 'sync-first';

/** A request the services refuse before anything is written or sent. Never carries secrets. */
export class DraftError extends Error {
  override readonly name = 'DraftError';

  constructor(
    readonly code: DraftErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
  }
}

/** What callers (API, MCP, dashboard) see of a draft. */
export interface DraftView {
  id: string;
  slug: string;
  platform: PlatformId;
  account: string;
  route: RouteKind;
  kind: DraftKind;
  status: DraftStatus;
  authorship: Authorship;
  payload: unknown;
  payloadSha256: string;
  lint: LintResult[];
  notBefore?: string;
  scheduledAt?: string;
  remoteRef?: string;
  remoteScheduledId?: string;
  failureReason?: string;
}

export function toDraftView(d: Draft): DraftView {
  const view: DraftView = {
    id: d.id,
    slug: d.slug,
    platform: d.platform,
    account: d.account,
    route: d.route,
    kind: d.kind,
    status: d.status,
    authorship: d.authorship,
    payload: d.payload,
    payloadSha256: d.payloadSha256,
    lint: d.lint,
  };
  if (d.notBefore !== undefined) view.notBefore = d.notBefore;
  if (d.scheduledAt !== undefined) view.scheduledAt = d.scheduledAt;
  if (d.remoteRef !== undefined) view.remoteRef = d.remoteRef;
  if (d.remoteScheduledId !== undefined) view.remoteScheduledId = d.remoteScheduledId;
  if (d.failureReason !== undefined) view.failureReason = d.failureReason;
  return view;
}

// ---- transforms built from config --------------------------------------------------------------

export interface ConfiguredTransforms {
  devto: Transform<Record<string, unknown>>;
  linkedin: Transform<Record<string, unknown>>;
}

/** The transforms as configured: dev.to tag preference, LinkedIn link card on or off. */
export function transformsFor(config: Config): ConfiguredTransforms {
  return {
    devto: createDevtoTransform({ tagPreference: config.platforms.devto?.tagPreference ?? [], placeholderUrls: [] }) as unknown as Transform<
      Record<string, unknown>
    >,
    linkedin: createLinkedinTransform({ linkCard: config.platforms.linkedin?.linkCard ?? false }) as unknown as Transform<
      Record<string, unknown>
    >,
  };
}

/** The gate's `lintDraft` dependency, so approval and authorize lint with the same config as the drafts. */
export function lintDraftFor(config: Config): LintDraft {
  return (draft, item) => {
    if (!DRAFT_PLATFORMS.has(draft.platform)) {
      return [{ rule: 'no-transform', severity: 'error', message: `no transform is registered for ${draft.platform}` }];
    }
    return transformsFor(config)[draft.platform as DraftPlatform].lint(draft.payload as Record<string, unknown>, item);
  };
}

// ---- payload schemas (what Claude may send) -----------------------------------------------------

const DevtoPatch = z.strictObject({
  title: z.string().optional(),
  body_markdown: z.string().optional(),
  published: z.literal(false).optional(),
  canonical_url: z.string().optional(),
  main_image: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  series: z.string().optional(),
});

const LinkedinPatch = z.strictObject({
  text: z.string().optional(),
  link: z
    .strictObject({ url: z.string(), title: z.string(), description: z.string(), thumbnailUrl: z.string() })
    .optional(),
});

const PATCH_SCHEMAS: Record<DraftPlatform, z.ZodType<Record<string, unknown>>> = {
  devto: DevtoPatch,
  linkedin: LinkedinPatch,
};

/** Validates a payload patch and drops keys whose value is undefined. */
function parsePatch(platform: DraftPlatform, raw: unknown): Record<string, unknown> {
  const parsed = PATCH_SCHEMAS[platform].safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(payload)'}: ${i.message}`).join('; ');
    throw new DraftError('invalid-payload', issues, { issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })) });
  }
  return Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
}

// ---- service -----------------------------------------------------------------------------------

export interface CreateDraftInput {
  slug: string;
  platform: DraftPlatform;
  account?: string;
  /** Omitted: the transform skeleton. Given: validated, then merged over the skeleton. */
  payload?: unknown;
  authorship?: Authorship;
}

export interface DraftsServiceDeps {
  repos: Repos;
  routes: RouteRegistry;
  /** The live config, read on every call. */
  config: () => Config;
  /** The post as it is on disk now (a fresh read, never a cache), or undefined when unreadable. */
  loadContentItem: (slug: string) => ContentItem | undefined;
  audit: Audit;
  notifier: Notifier;
  newId?: () => string;
}

const ACTOR = 'drafts';
const DEFAULT_ACCOUNT = 'default';
/** The only states a stage may start from or write back into. */
const STAGEABLE: ReadonlySet<DraftStatus> = new Set<DraftStatus>(['draft', 'staged']);
/** Draft states that go back to draft (or staged) when the payload is edited. */
const RESET_ON_EDIT: ReadonlySet<DraftStatus> = new Set<DraftStatus>(['pending_approval', 'approved', 'scheduled', 'failed', 'held']);

/**
 * Drafts: create from the transform skeleton (optionally merged with Claude's adaptation), edit,
 * preview and stage. Every write recomputes the approval hash; an edit invalidates every pending or
 * approved approval for the draft, so an approval can never outlive the text it was given for.
 */
export class DraftsService {
  readonly #deps: DraftsServiceDeps;
  readonly #newId: () => string;

  constructor(deps: DraftsServiceDeps) {
    this.#deps = deps;
    this.#newId = deps.newId ?? randomUUID;
  }

  create(input: CreateDraftInput): DraftView {
    const { repos } = this.#deps;
    const platform = this.#platform(input.platform);
    const item = this.#item(input.slug);
    const content = repos.content.get(input.slug);
    if (content === undefined) throw new DraftError('unknown-post', `${input.slug} has not been synced yet`);
    // A draft is bound to the post version the content row records. If the post on disk is newer,
    // the draft would be built from text sync has not seen (and could not flag later): sync first.
    if (item.source.mdxSha256 !== content.mdxSha256 || item.source.notesSha256 !== content.notesSha256) {
      throw new DraftError('sync-first', `${input.slug} changed on disk since the last sync; run sync, then create the draft`);
    }

    const transform = transformsFor(this.#deps.config())[platform];
    const skeleton = transform.skeleton(item);
    const payload = input.payload === undefined ? skeleton : { ...skeleton, ...parsePatch(platform, input.payload) };
    this.#checkFullText(platform, payload, skeleton);

    let notBefore: string | undefined;
    if (platform === 'devto') {
      if (content.t0 === undefined) {
        throw new DraftError('canonical-not-live', `${content.canonicalUrl} has not passed the live check, so T0 (and dev.to's not-before) is unknown`);
      }
      notBefore = new Date(Date.parse(content.t0) + DEVTO_DELAY_MS).toISOString();
    }

    const account = input.account ?? DEFAULT_ACCOUNT;
    const route = activeRouteKind(platform, this.#deps.config());
    const draft = repos.drafts.insert({
      id: this.#newId(),
      slug: input.slug,
      platform,
      account,
      route,
      kind: transform.kind,
      status: 'draft',
      payload,
      payloadSha256: recomputeHash({ platform, account, route, payload }),
      authorship: this.#authorship(platform, payload, skeleton, input.authorship),
      lint: transform.lint(payload, item),
      ...(notBefore === undefined ? {} : { notBefore }),
      sourceMdxSha256: content.mdxSha256,
      ...(content.notesSha256 === undefined ? {} : { sourceNotesSha256: content.notesSha256 }),
    });
    this.#deps.audit({
      actorChannel: ACTOR,
      action: 'draft_created',
      draftId: draft.id,
      hash: draft.payloadSha256,
      platform,
      detail: { slug: draft.slug, route, authorship: draft.authorship, lintErrors: draft.lint.filter((l) => l.severity === 'error').length },
    });
    return toDraftView(draft);
  }

  /**
   * Applies a payload patch (validated like `create`, merged over the current payload). Refused while
   * the draft is in flight or out. A real change recomputes hash, lint and authorship and invalidates
   * the draft's pending and approved approvals in the same transaction. If a platform scheduler holds
   * the old post, it is cancelled afterwards (a failure is audited and toasted, never silent).
   */
  async update(id: string, patch: unknown): Promise<DraftView> {
    const { repos } = this.#deps;
    const before = this.#draft(id);
    const platform = this.#platform(before.platform);
    const item = this.#item(before.slug);
    const transform = transformsFor(this.#deps.config())[platform];
    const skeleton = transform.skeleton(item);
    const changes = parsePatch(platform, patch);

    const edited = repos.transaction(() => {
      const current = this.#draft(id);
      if (ALREADY_OUT.has(current.status)) {
        throw new DraftError('not-editable', `a draft that is ${current.status} cannot be edited`, { status: current.status });
      }
      const payload = { ...(current.payload as Record<string, unknown>), ...changes };
      this.#checkFullText(platform, payload, skeleton);
      const next = { ...current, payload };
      const hash = recomputeHash(next);
      if (hash === current.payloadSha256) return undefined;

      const status: DraftStatus = RESET_ON_EDIT.has(current.status) ? (current.remoteRef === undefined ? 'draft' : 'staged') : current.status;
      const authorship = platform === 'devto' ? 'reformatted' : this.#editedAuthorship(payload, skeleton, current.authorship);
      const ok = repos.drafts.update(
        id,
        { payload, payloadSha256: hash, authorship, lint: transform.lint(payload, item), status, failureReason: null },
        current.payloadSha256,
      );
      if (!ok) throw new DraftError('conflict', 'the draft changed while it was being edited; read it again');

      const invalidated: string[] = [];
      for (const approval of repos.approvals.listByDraft(id)) {
        if (approval.status === 'pending' && repos.approvals.setStatus(approval.id, 'invalidated', { from: 'pending' })) invalidated.push(approval.id);
        if (approval.status === 'approved' && repos.approvals.setStatus(approval.id, 'invalidated', { from: 'approved' })) invalidated.push(approval.id);
      }
      this.#deps.audit({
        actorChannel: ACTOR,
        action: 'draft_edited',
        draftId: id,
        hash,
        platform,
        detail: { oldHash: current.payloadSha256, newHash: hash, fields: Object.keys(changes), invalidatedApprovals: invalidated, from: current.status, to: status },
      });
      return current;
    });

    if (edited?.remoteScheduledId !== undefined) await this.#cancelRemote(edited);
    return toDraftView(this.#draft(id));
  }

  get(id: string): DraftView {
    return toDraftView(this.#draft(id));
  }

  list(filter?: DraftFilter): DraftView[] {
    return this.#deps.repos.drafts.list(filter).map(toDraftView);
  }

  /** The deterministic skeleton for a platform and its lint, without writing anything. */
  preview(slug: string, platform: DraftPlatform): { payload: unknown; lint: LintResult[] } {
    const p = this.#platform(platform);
    const item = this.#item(slug);
    const transform = transformsFor(this.#deps.config())[p];
    const payload = transform.skeleton(item);
    return { payload, lint: transform.lint(payload, item) };
  }

  /**
   * Puts a private copy on the platform (only routes with a private stage). Never makes anything
   * public. Only a `draft` or `staged` draft can be staged, checked before the call and again when it
   * returns: a stage that finishes after a publish was authorized changes nothing locally.
   */
  async stage(id: string): Promise<RemoteRef> {
    const { repos } = this.#deps;
    const draft = this.#draft(id);
    if (!STAGEABLE.has(draft.status)) {
      throw new DraftError('not-stageable', `a draft that is ${draft.status} cannot be staged`, { status: draft.status });
    }
    const route = this.#deps.routes.get(draft.platform, draft.route);
    if (route?.stage === undefined) {
      throw new DraftError('no-stage', `the ${draft.route} route for ${draft.platform} has no private stage`);
    }
    let ref: RemoteRef;
    try {
      ref = await route.stage(draft);
    } catch (error) {
      this.#deps.audit({
        actorChannel: ACTOR,
        action: 'stage_failed',
        draftId: id,
        hash: draft.payloadSha256,
        platform: draft.platform,
        detail: { route: draft.route, error: errorText(error) },
      });
      throw error;
    }
    // Re-checked inside the write: if a publish was authorized meanwhile, nothing local changes.
    const late = repos.transaction(() => {
      const current = this.#draft(id);
      if (!STAGEABLE.has(current.status)) return current;
      repos.drafts.update(id, { remoteRef: ref.remoteId, status: 'staged' });
      this.#deps.audit({
        actorChannel: ACTOR,
        action: 'staged',
        draftId: id,
        hash: draft.payloadSha256,
        platform: draft.platform,
        detail: { route: draft.route, remoteId: ref.remoteId, ...(ref.previewUrl === undefined ? {} : { previewUrl: ref.previewUrl }) },
      });
      return undefined;
    });
    if (late !== undefined) {
      this.#deps.audit({
        actorChannel: ACTOR,
        action: 'stage_discarded',
        draftId: id,
        hash: late.payloadSha256,
        platform: draft.platform,
        detail: { route: draft.route, remoteId: ref.remoteId, status: late.status },
      });
      throw new DraftError('not-stageable', `the draft became ${late.status} while it was being staged; nothing was changed`, {
        status: late.status,
        remoteId: ref.remoteId,
      });
    }
    return ref;
  }

  /**
   * The owner confirms he deleted the platform's scheduled post by hand after a failed cancel. Until
   * this (or a successful `cancelScheduled`) clears `remoteScheduledId`, the gate refuses to approve
   * the draft again (REMOTE_SCHEDULED).
   */
  confirmRemoteCancelled(id: string, actor = 'dashboard'): DraftView {
    const { repos } = this.#deps;
    repos.transaction(() => {
      const draft = this.#draft(id);
      if (draft.remoteScheduledId === undefined) throw new DraftError('no-remote-schedule', 'no scheduled post is recorded for this draft');
      repos.drafts.update(id, { remoteScheduledId: null });
      this.#deps.audit({
        actorChannel: actor,
        action: 'remote_cancel_confirmed',
        draftId: id,
        hash: draft.payloadSha256,
        platform: draft.platform,
        detail: { remoteScheduledId: draft.remoteScheduledId },
      });
    });
    return this.get(id);
  }

  // ---- internals -------------------------------------------------------------------------------

  #draft(id: string): Draft {
    const draft = this.#deps.repos.drafts.get(id);
    if (draft === undefined) throw new DraftError('unknown-draft', `no draft ${id}`);
    return draft;
  }

  #item(slug: string): ContentItem {
    const item = this.#deps.loadContentItem(slug);
    if (item === undefined) throw new DraftError('unknown-post', `the post ${slug} cannot be read`);
    return item;
  }

  #platform(platform: string): DraftPlatform {
    if (!DRAFT_PLATFORMS.has(platform)) throw new DraftError('unsupported-platform', `drafts for ${platform} are not supported yet`);
    return platform as DraftPlatform;
  }

  /** Full-text copies are the user's own words, mechanically transformed: Claude may not rewrite them. */
  #checkFullText(platform: DraftPlatform, payload: Record<string, unknown>, skeleton: Record<string, unknown>): void {
    if (platform === 'devto' && payload['body_markdown'] !== skeleton['body_markdown']) {
      throw new DraftError('full-text-immutable', 'body_markdown must stay exactly as rendered from the post; edit the post itself instead');
    }
  }

  #authorship(platform: DraftPlatform, payload: Record<string, unknown>, skeleton: Record<string, unknown>, given: Authorship | undefined): Authorship {
    if (platform === 'devto') return 'reformatted';
    // Rewritten text is Claude's prose whatever the caller says (ruling 8).
    if (payload['text'] !== skeleton['text']) return 'ai-assisted';
    return given ?? 'reformatted';
  }

  #editedAuthorship(payload: Record<string, unknown>, skeleton: Record<string, unknown>, current: Authorship): Authorship {
    if (payload['text'] !== skeleton['text']) return 'ai-assisted';
    return current === 'ai-assisted' ? 'reformatted' : current;
  }

  /** Cancels the post a platform scheduler still holds for this draft (spec 2.6 rule 5). */
  async #cancelRemote(draft: Draft): Promise<void> {
    const { repos, notifier } = this.#deps;
    const route = this.#deps.routes.get(draft.platform, draft.route);
    try {
      if (route?.cancelScheduled === undefined) throw new Error(`the ${draft.route} route for ${draft.platform} cannot cancel a scheduled post`);
      await route.cancelScheduled(draft);
    } catch (error) {
      this.#deps.audit({
        actorChannel: ACTOR,
        action: 'remote_cancel_failed',
        draftId: draft.id,
        platform: draft.platform,
        detail: { remoteScheduledId: draft.remoteScheduledId, error: errorText(error) },
      });
      await notifier.toast(
        'Cancel the scheduled post by hand',
        `The ${draft.platform} post for ${draft.slug} is still scheduled on the platform with the old text, and the cancel failed. Delete it there now.`,
        'critical',
      );
      return;
    }
    repos.drafts.update(draft.id, { remoteScheduledId: null });
    this.#deps.audit({
      actorChannel: ACTOR,
      action: 'remote_cancelled',
      draftId: draft.id,
      platform: draft.platform,
      detail: { remoteScheduledId: draft.remoteScheduledId },
    });
    await notifier.toast('Remote scheduled post cancelled, re-approve', `The ${draft.platform} post for ${draft.slug} was edited.`, 'warning');
  }
}

import { z } from 'zod';
import { PLATFORM_IDS, PLATFORMS } from '../../lib/catalog';
import { buildManualKit, validateManualUrl, type ManualContext } from '../../lib/manual';
import { previewText } from '../../lib/previews';
import {
  PAYLOAD_FIELDS,
  diffPayload,
  type CanonicalCheckDTO,
  type DraftExtras,
  type DraftPayload,
  type PayloadField,
  type PlatformDraftDTO,
  type PlatformId,
} from '../../lib/publishing';
import {
  DATE_FORMATS,
  OPTION_KEYS,
  SITE_LIMITS,
  SITE_PRESETS,
  isSafeBranch,
  parseRepo,
  renderSiteFile,
  resolvePathTemplate,
  validateRepoPath,
  type SiteDraftOptions,
  type SiteSettingsDTO,
} from '../../lib/site-export';
import { PublishRefusal } from '../data/tenant';
import type { PlatformDraft } from '../db/schema';
import { isPrivateHost } from '../publishing/lint';
import type { PublishEnv } from '../publishing/registry';
import { adapterFor } from '../publishing/registry';
import { payloadHashOf } from '../publishing/source';
import { toCanonicalDTO } from '../publishing/views';
import { ActionError, parseId, parseInput, type OwnerContext } from './owner';
import { checklistFor, contextLint, draftView, loadDraft, refresh, refreshCanonical, requireOwnerActor, siteHostOf, toSiteSettingsDTO } from './publishing';

/*
 * The composer's own actions: which destinations an article has, editing one destination's payload (every edit is
 * a new hash and voids its approvals), the personal site's settings, the canonical page check, recording a post
 * made by hand, and the read-only views of a draft (the exported file, the approximate preview).
 */

// ---- destinations ------------------------------------------------------------------------------------

const addSchema = z.object({ platform: z.enum(PLATFORM_IDS) }).strict();

/** Add a destination to an article. Nothing is prepared or sent: the card starts as "not prepared". */
export async function addDestination(owner: OwnerContext, articleId: unknown, input: unknown): Promise<{ platform: PlatformId; position: number }> {
  const id = parseId(articleId, 'Article');
  const { platform } = parseInput(addSchema, input);
  if (!(await owner.data.articles.get(id))) throw new ActionError('not_found', 'Article not found');
  const row = await owner.data.destinations.add(id, platform);
  await owner.data.audit.record({ actor: owner.actor, action: 'destination.added', entityType: 'article', entityId: id, metadata: { platform } });
  return { platform: row.platform, position: row.position };
}

/**
 * Take a destination off an article. A draft that never went out goes with it. One that is published, in flight or
 * of unknown result stays as the record of what happened, so the destination cannot be removed.
 */
export async function removeDestination(owner: OwnerContext, articleId: unknown, platform: unknown): Promise<void> {
  const id = parseId(articleId, 'Article');
  const target = parseInput(z.enum(PLATFORM_IDS), platform);
  if (!(await owner.data.articles.get(id))) throw new ActionError('not_found', 'Article not found');
  const draft = await owner.data.platformDrafts.current(id, target);
  if (draft && !(await owner.data.platformDrafts.removeUnsent(draft.id))) {
    throw new ActionError('conflict', `This ${PLATFORMS[target].name} destination cannot be removed: its post is published, in flight or has an unknown result. The record stays.`, {}, { code: 'ALREADY_OUT' });
  }
  await owner.data.destinations.remove(id, target);
  await owner.data.audit.record({ actor: owner.actor, action: 'destination.removed', entityType: 'article', entityId: id, metadata: { platform: target } });
}

const orderSchema = z.object({ order: z.array(z.enum(PLATFORM_IDS)).max(PLATFORM_IDS.length) }).strict();

export async function reorderDestinations(owner: OwnerContext, articleId: unknown, input: unknown): Promise<void> {
  const id = parseId(articleId, 'Article');
  const { order } = parseInput(orderSchema, input);
  if (new Set(order).size !== order.length) throw new ActionError('invalid', 'List each destination once.', { order: 'List each destination once.' });
  if (!(await owner.data.articles.get(id))) throw new ActionError('not_found', 'Article not found');
  await owner.data.destinations.reorder(id, order);
}

// ---- the personal site's settings ---------------------------------------------------------------------

const fieldName = z
  .string()
  .max(SITE_LIMITS.fieldName)
  .regex(/^[A-Za-z0-9_.-]*$/, 'Use letters, numbers, dots, dashes and underscores only.');

const mappingSchema = z
  .object({
    preset: z.enum(SITE_PRESETS),
    fields: z
      .object({ title: fieldName, description: fieldName, date: fieldName, tags: fieldName, canonical: fieldName, cover: fieldName, slug: fieldName, series: fieldName, draft: fieldName })
      .strict(),
    dateFormat: z.enum(DATE_FORMATS),
    extension: z.enum(['md', 'mdx']),
    fixed: z
      .array(z.object({ key: fieldName.min(1, 'Name the key.'), value: z.union([z.string().max(SITE_LIMITS.fixedValue), z.boolean()]) }).strict())
      .max(SITE_LIMITS.fixedKeys),
  })
  .strict();

const siteSchema = z
  .object({
    siteUrl: z.string().trim().max(300).nullable().optional(),
    repo: z.string().trim().max(SITE_LIMITS.repo).nullable().optional(),
    baseBranch: z.string().trim().min(1).max(SITE_LIMITS.branch),
    pathTemplate: z.string().trim().min(1).max(SITE_LIMITS.pathTemplate),
    preset: z.enum(SITE_PRESETS),
    mapping: mappingSchema,
  })
  .strict();

export async function getSiteSettings(owner: OwnerContext): Promise<SiteSettingsDTO> {
  return toSiteSettingsDTO(await owner.data.siteSettings.get());
}

/** Save where the site lives and how a file is laid out. Nothing is sent anywhere; a GitHub token is a separate step. */
export async function saveSiteSettings(owner: OwnerContext, input: unknown): Promise<SiteSettingsDTO> {
  requireOwnerActor(owner, 'Changing the site settings');
  const values = parseInput(siteSchema, input);
  const fields: Record<string, string> = {};

  let siteUrl: string | null = null;
  if (values.siteUrl) {
    try {
      const url = new URL(values.siteUrl);
      if (url.protocol !== 'https:' || isPrivateHost(url.hostname) || url.username || url.password) throw new Error('not public https');
      siteUrl = url.origin;
    } catch {
      fields.siteUrl = 'Enter your site’s public address, starting with https://.';
    }
  }
  let repo: string | null = null;
  if (values.repo) {
    if (parseRepo(values.repo)) repo = values.repo.trim();
    else fields.repo = 'Write the repository as owner/name.';
  }
  if (!isSafeBranch(values.baseBranch)) fields.baseBranch = 'That is not a branch name this app can use.';
  if (values.baseBranch.startsWith('brand-os/')) fields.baseBranch = 'The base branch cannot be one of this app’s own working branches.';
  const sample = resolvePathTemplate(values.pathTemplate, { slug: 'sample-post', dateIso: '2026-01-02T03:04:05Z', extension: values.mapping.extension });
  if (!sample.ok) fields.pathTemplate = sample.reason;
  const used = Object.values(values.mapping.fields).filter((name) => name !== '');
  if (new Set(used).size !== used.length) fields.mapping = 'Two parts of the post use the same front matter key.';
  if (Object.keys(fields).length > 0) throw new ActionError('invalid', 'Some settings need attention.', fields);

  const row = await owner.data.siteSettings.save({
    siteUrl,
    repo,
    baseBranch: values.baseBranch,
    pathTemplate: values.pathTemplate,
    preset: values.preset,
    mapping: values.mapping,
  });
  await owner.data.audit.record({ actor: owner.actor, action: 'site_settings.saved', entityType: 'site_settings', entityId: row.id, metadata: { preset: row.preset, hasRepo: Boolean(row.repo) } });
  return toSiteSettingsDTO(row);
}

// ---- canonical page ----------------------------------------------------------------------------------

/** Look at the article's canonical page now (read-only, SSRF-safe) and keep the result. */
export async function checkCanonical(owner: OwnerContext, env: PublishEnv, articleId: unknown): Promise<{ check: CanonicalCheckDTO | null; reason: string | null }> {
  const id = parseId(articleId, 'Article');
  const article = await owner.data.articles.get(id);
  if (!article) throw new ActionError('not_found', 'Article not found');
  if (!article.canonicalUrl) return { check: null, reason: 'This article has no canonical URL. Set one in the article’s details.' };
  const row = await refreshCanonical(owner, env, article, article.canonicalUrl);
  return { check: row ? toCanonicalDTO(row) : null, reason: null };
}

// ---- editing one destination -------------------------------------------------------------------------

const editSchema = z
  .object({
    /** The payload hash the screen showed. If the draft has moved on, the edit is refused. */
    expectedHash: z.string().regex(/^[0-9a-f]{64}$/, 'Missing the hash of the draft being edited.'),
    title: z.string().max(400).optional(),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().trim().max(80)).max(60).optional(),
    canonicalUrl: z.string().trim().max(2000).nullable().optional(),
    coverImageUrl: z.string().trim().max(2000).nullable().optional(),
    series: z.string().trim().max(100).nullable().optional(),
    bodyMarkdown: z.string().max(400_000).optional(),
    options: z.partialRecord(z.enum(OPTION_KEYS), z.string().trim().max(100)).optional(),
    site: z
      .object({
        updateExisting: z.boolean().optional(),
        path: z.string().trim().max(300).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface EditOutcome {
  draft: PlatformDraftDTO;
  /** False when the edit did not change the payload, so nothing was voided. */
  changed: boolean;
  fields: string[];
  /** An open approval was voided by this edit. */
  voidedApproval: boolean;
  message: string;
}

const EDITING_WHY: Record<string, string> = {
  publishing: 'It is being published right now, so it cannot be edited.',
  published: 'It is already published. Changing a live post is not built yet.',
  unknown: 'Its last publish has an unknown result. Settle that first.',
  source_changed: 'The article changed after this draft was built. Rebuild the draft first, then edit.',
  approved: 'It is being published.',
};

function cleanUrl(value: string | null | undefined): string | null | 'invalid' {
  if (value === null || value === undefined || value === '') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'invalid';
    return url.toString();
  } catch {
    return 'invalid';
  }
}

/**
 * Change one destination's payload. The new payload has a new hash, so any open approval is void and the draft goes
 * back to `draft` (a private copy on the platform no longer matches what would be sent). Other destinations are not
 * touched. Divergence from the generated text stays visible and "reset to generated" brings it back.
 */
export async function editDraft(owner: OwnerContext, env: Pick<PublishEnv, 'now'>, id: unknown, input: unknown): Promise<EditOutcome> {
  const values = parseInput(editSchema, input);
  const first = await loadDraft(owner, id);
  await refresh(owner, env, first.articleId);
  const draft = await loadDraft(owner, id);
  const info = PLATFORMS[draft.platform];
  if (draft.status === 'source_changed' || draft.stale) throw new ActionError('conflict', EDITING_WHY.source_changed!, {}, { code: 'SOURCE_CHANGED' });
  if (!['draft', 'staged', 'pending_approval', 'failed'].includes(draft.status)) throw new ActionError('conflict', EDITING_WHY[draft.status] ?? 'This draft cannot be edited now.', {}, { code: 'STATUS' });
  if (draft.payloadSha256 !== values.expectedHash) {
    throw new ActionError('conflict', 'This destination changed since you opened it. Reload it to see the current text.', {}, { code: 'STALE_EDIT', currentHash: draft.payloadSha256 });
  }

  const adapter = adapterFor(draft.platform);
  const payload: DraftPayload = { ...draft.payload };
  const fieldErrors: Record<string, string> = {};
  if (values.title !== undefined) payload.title = values.title.replace(/\s+/g, ' ').trim();
  if (values.description !== undefined) payload.description = values.description.replace(/\s+/g, ' ').trim();
  if (values.bodyMarkdown !== undefined) payload.bodyMarkdown = values.bodyMarkdown;
  if (values.series !== undefined) payload.series = values.series ? values.series : null;
  if (values.canonicalUrl !== undefined) {
    const url = cleanUrl(values.canonicalUrl);
    if (url === 'invalid') fieldErrors.canonicalUrl = 'Enter a full web address, starting with https://, or leave it empty.';
    else payload.canonicalUrl = url;
  }
  if (values.coverImageUrl !== undefined) {
    const trimmed = values.coverImageUrl ?? '';
    payload.coverImageUrl = trimmed === '' ? null : trimmed;
  }
  let tagReport = draft.tagReport;
  if (values.tags !== undefined) {
    tagReport = adapter.tags(values.tags);
    payload.tags = tagReport.sent;
  }
  if (Object.keys(fieldErrors).length > 0) throw new ActionError('invalid', 'Some fields need attention.', fieldErrors);

  const extras: DraftExtras = JSON.parse(JSON.stringify(draft.extras)) as DraftExtras;
  if (values.options) {
    const options: Record<string, string> = { ...(extras.options ?? {}) };
    for (const [key, value] of Object.entries(values.options)) {
      const cleaned = key === 'subreddit' ? value.replace(/^r\//i, '').trim() : value.trim();
      if (cleaned) options[key] = cleaned;
      else delete options[key];
    }
    if (Object.keys(options).length > 0) extras.options = options;
    else delete extras.options;
  }
  if (values.site) {
    if (draft.platform !== 'site' || !extras.site) throw new ActionError('invalid', 'Site options only apply to the personal site.');
    const site: SiteDraftOptions = extras.site;
    if (values.site.path !== undefined && values.site.path !== site.path) {
      const checked = validateRepoPath(values.site.path);
      if (!checked.ok) throw new ActionError('invalid', checked.reason, { 'site.path': checked.reason });
      site.path = checked.path;
      site.updateExisting = false;
      site.expectedSha = null;
    }
    if (values.site.updateExisting !== undefined) {
      if (values.site.updateExisting) {
        const seen = draft.remoteInfo;
        if (!seen?.fileExists || !seen.fileSha || seen.path !== site.path) {
          throw new ActionError('invalid', 'Check the target on GitHub first. “Update existing” is only offered for a file you have seen there.', { 'site.updateExisting': 'Check the target first.' });
        }
        site.updateExisting = true;
        site.expectedSha = seen.fileSha;
      } else {
        site.updateExisting = false;
        site.expectedSha = null;
      }
    }
  }

  const article = await owner.data.articles.get(draft.articleId);
  const connection = await owner.data.connections.getByPlatform(draft.platform);
  const lint = article ? [...adapter.validate(payload, extras), ...contextLint(draft.platform, article, payload, connection ? connection.config : null)] : adapter.validate(payload, extras);
  const payloadSha256 = payloadHashOf(draft.platform, draft.account, payload, extras);
  const changedFields: string[] = [...diffPayload(draft.payload, payload)];
  if (JSON.stringify(extras) !== JSON.stringify(draft.extras)) changedFields.push('options');

  if (payloadSha256 === draft.payloadSha256) {
    return { draft: await draftView(owner, draft), changed: false, fields: [], voidedApproval: false, message: `Nothing changed in this ${info.name} draft.` };
  }
  const hadApproval = draft.status === 'pending_approval';
  const generated = draft.generatedPayload && Object.keys(draft.generatedPayload).length > 0 ? draft.generatedPayload : draft.payload;
  const row = await owner.data.platformDrafts.applyEdit(draft.id, {
    expectedHash: draft.payloadSha256,
    payload,
    payloadSha256,
    tagReport,
    lint,
    extras,
    reset: diffPayload(payload, generated).length === 0,
  });
  if (!row) throw new ActionError('conflict', 'This draft changed while you were editing it. Reload it and try again.', {}, { code: 'STALE_EDIT' });
  await owner.data.audit.record({ actor: owner.actor, action: 'platform_draft.edited', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, fields: changedFields, voidedApproval: hadApproval } });
  return {
    draft: await draftView(owner, row),
    changed: true,
    fields: changedFields,
    voidedApproval: hadApproval,
    message: hadApproval
      ? `Saved. This edit made a new payload, so the approval you were asked for is void. ${info.state === 'adapter' ? 'Stage and ask again.' : ''}`.trim()
      : `Saved. This ${info.name} draft is a new payload now${info.state === 'adapter' ? ', so it needs staging again before it can be approved' : ''}.`,
  };
}

const resetSchema = z.object({ fields: z.array(z.enum(PAYLOAD_FIELDS)).min(1).optional() }).strict();

/** Put some or all fields of a destination back to what was generated from the article. */
export async function resetDraft(owner: OwnerContext, env: Pick<PublishEnv, 'now'>, id: unknown, input: unknown = {}): Promise<EditOutcome> {
  const { fields } = parseInput(resetSchema, input ?? {});
  const draft = await loadDraft(owner, id);
  const generated = draft.generatedPayload && Object.keys(draft.generatedPayload).length > 0 ? draft.generatedPayload : draft.payload;
  const patch: Record<string, unknown> = {};
  for (const field of (fields ?? PAYLOAD_FIELDS) as readonly PayloadField[]) {
    if (field === 'coverImageUrl' || field === 'series' || field === 'canonicalUrl') patch[field] = generated[field];
    else patch[field] = generated[field];
  }
  return editDraft(owner, env, id, { ...patch, expectedHash: draft.payloadSha256 });
}

// ---- recording a post made by hand -------------------------------------------------------------------

const recordSchema = z
  .object({
    checked: z.array(z.string().max(300)).max(20),
    url: z.string().trim().min(1, 'Enter the address of the post.').max(2000),
  })
  .strict();

export interface RecordOutcome {
  outcome: 'recorded';
  message: string;
  draft: PlatformDraftDTO;
}

/** The facts the manual kit and the link check need about the personal site. */
export async function manualContextFor(owner: OwnerContext, draft?: PlatformDraft): Promise<ManualContext> {
  const settings = toSiteSettingsDTO(await owner.data.siteSettings.get());
  const site = draft?.extras.site;
  let siteFile: string | null = null;
  if (draft && site) siteFile = renderSiteFile(draft.payload, site.mapping, site.dateIso, site.slug).content;
  return { siteHost: siteHostOf(settings), siteRepo: site?.repo ?? settings.repo, siteBase: site?.baseBranch ?? settings.baseBranch, sitePath: site?.path ?? null, siteFile };
}

/**
 * Record that the owner posted this exact payload by hand. It needs the same kind of approval as a publish (a
 * single-use request bound to the payload hash, checklist ticked, signed-in owner), but nothing is sent to any
 * platform and the draft is marked "posted by hand": the app never claims it published it. The link has to be a
 * plain https address on a host that platform really uses.
 */
export async function recordManualPost(owner: OwnerContext, env: Pick<PublishEnv, 'now'>, approvalId: unknown, input: unknown): Promise<RecordOutcome> {
  requireOwnerActor(owner, 'Recording a post made by hand');
  const id = parseId(approvalId, 'Approval');
  const { checked, url } = parseInput(recordSchema, input);
  const approval = await owner.data.platformDrafts.getApproval(id);
  if (!approval) throw new ActionError('not_found', 'Approval not found');
  const draft = await owner.data.platformDrafts.get(approval.draftId);
  if (!draft) throw new ActionError('not_found', 'Draft not found');
  if (approval.kind !== 'manual') throw new ActionError('conflict', 'This approval is for publishing, not for recording a post made by hand.', {}, { code: 'APPROVAL_INVALID' });

  const required = await checklistFor(owner, draft, 'manual');
  const missing = required.filter((box) => !checked.includes(box));
  if (missing.length > 0) {
    throw new ActionError('invalid', `Tick every box before recording (${missing.length} left).`, { checked: 'Every box must be ticked.' }, { code: 'CHECKLIST', missing });
  }
  const verdict = validateManualUrl(draft.platform, url, await manualContextFor(owner, draft));
  if (!verdict.ok) throw new ActionError('invalid', verdict.reason, { url: verdict.reason });

  const now = (env.now ?? (() => new Date()))();
  let recorded;
  try {
    recorded = await owner.data.platformDrafts.recordManualPost({ draftId: draft.id, approvalId: approval.id, checked, remoteUrl: verdict.url, now });
  } catch (err) {
    if (err instanceof PublishRefusal) {
      await owner.data.audit.record({ actor: owner.actor, action: 'approval.refused', entityType: 'approval', entityId: approval.id, metadata: { code: err.code, draftId: draft.id, mode: 'manual' } });
      throw new ActionError('conflict', err.message, {}, { code: err.code });
    }
    throw err;
  }
  await owner.data.audit.record({ actor: owner.actor, action: 'platform.recorded_by_hand', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, host: verdict.host, approvalId: approval.id } });
  return {
    outcome: 'recorded',
    message: `Recorded as posted by hand on ${PLATFORMS[draft.platform].name}. This app did not publish it.`,
    draft: await draftView(owner, recorded.draft),
  };
}

// ---- read-only views ---------------------------------------------------------------------------------

export interface DraftExport {
  filename: string;
  mime: string;
  content: string;
}

/**
 * The finished file for the personal site (front matter and body, LF line endings), or the manual-posting text for
 * any other destination. No network, nothing stored.
 */
export async function exportDraft(owner: OwnerContext, id: unknown): Promise<DraftExport> {
  const draft = await loadDraft(owner, id);
  const context = await manualContextFor(owner, draft);
  if (draft.platform === 'site') {
    const site = draft.extras.site;
    if (!site) throw new ActionError('conflict', 'This draft has no personal-site options. Rebuild it.');
    const file = renderSiteFile(draft.payload, site.mapping, site.dateIso, site.slug);
    return { filename: site.path.split('/').pop() ?? `${site.slug}.md`, mime: 'text/markdown; charset=utf-8', content: file.content };
  }
  const kit = buildManualKit(draft.platform, draft.payload, draft.extras, context);
  return { filename: `${draft.platform}-${draft.payload.title.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'post'}.txt`, mime: 'text/plain; charset=utf-8', content: kit.all };
}

export interface PreviewView {
  draftId: string;
  platform: PlatformId;
  name: string;
  status: PlatformDraft['status'];
  payload: DraftPayload;
  lint: PlatformDraft['lint'];
  hasLintErrors: boolean;
  /** A plain-text rendering of how it looks there, labelled approximate. */
  preview: string;
  limits: (typeof PLATFORMS)[PlatformId]['limits'];
}

export async function getPreview(owner: OwnerContext, env: Pick<PublishEnv, 'now'>, id: unknown): Promise<PreviewView> {
  const first = await loadDraft(owner, id);
  await refresh(owner, env, first.articleId);
  const draft = await loadDraft(owner, id);
  return {
    draftId: draft.id,
    platform: draft.platform,
    name: PLATFORMS[draft.platform].name,
    status: draft.status,
    payload: draft.payload,
    lint: draft.lint,
    hasLintErrors: draft.lint.some((i) => i.severity === 'error'),
    preview: previewText(draft.platform, draft.payload, draft.extras),
    limits: PLATFORMS[draft.platform].limits,
  };
}

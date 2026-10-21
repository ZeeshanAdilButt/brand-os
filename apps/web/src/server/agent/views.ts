import { DRAFT_STATUS_HINTS, type PlatformDraftDTO } from '../../lib/publishing';
import type { ArticleListRow } from '../data/articles';
import type { Article, BrandPreferences, KnowledgeItem, Profile } from '../db/schema';

/**
 * What the agent API shows. Plain data with ISO dates and no owner id, no search vector and nothing
 * the caller did not ask for. One place, so a new column never leaks into the API by accident.
 */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function articleView(a: Article) {
  return {
    id: a.id,
    title: a.title,
    slug: a.slug,
    description: a.description,
    tags: a.tags,
    canonicalUrl: a.canonicalUrl,
    status: a.status,
    bodyMarkdown: a.bodyMarkdown,
    revision: a.revision,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export function articleRowView(a: ArticleListRow, snippet?: string) {
  return {
    id: a.id,
    title: a.title,
    slug: a.slug,
    description: a.description,
    tags: a.tags,
    status: a.status,
    chars: a.bodyChars,
    revision: a.revision,
    updatedAt: a.updatedAt.toISOString(),
    ...(snippet === undefined ? {} : { snippet }),
  };
}

export function itemView(item: KnowledgeItem, snippet?: string) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    tags: item.tags,
    sourceDate: item.sourceDate,
    verificationStatus: item.verificationStatus,
    confidence: item.confidence,
    confidentiality: item.confidentiality,
    publicUsePermitted: item.publicUsePermitted,
    lastReviewedAt: iso(item.lastReviewedAt),
    updatedAt: item.updatedAt.toISOString(),
    ...(snippet === undefined ? {} : { snippet }),
  };
}

export function profileView(p: Profile | null) {
  if (!p) return null;
  return {
    name: p.name,
    headline: p.headline,
    yearsExperience: p.yearsExperience,
    location: p.location,
    careerGoals: p.careerGoals,
    targetEmployers: p.targetEmployers,
    expertiseAreas: p.expertiseAreas,
  };
}

export function preferencesView(p: BrandPreferences | null) {
  if (!p) return null;
  return { tone: p.tone, audience: p.audience, writingStyle: p.writingStyle, avoid: p.avoid };
}

/**
 * A platform draft as an agent sees it: the content, the checks, what would be sent and where it stands.
 * No remote ids, no connection details and nothing that could be used to approve or publish; the approval
 * is described, never handed over.
 */
export function platformDraftView(d: PlatformDraftDTO) {
  return {
    id: d.id,
    articleId: d.articleId,
    platform: d.platform,
    status: d.status,
    statusMeaning: DRAFT_STATUS_HINTS[d.status],
    stale: d.stale,
    account: d.account,
    payload: d.payload,
    payloadSha256: d.payloadSha256,
    requestPreview: d.requestPreview,
    tagReport: d.tagReport,
    lint: d.lint,
    hasLintErrors: d.lint.some((issue) => issue.severity === 'error'),
    remoteUrl: d.remoteUrl,
    remotePreviewUrl: d.remotePreviewUrl,
    failure: d.failureMessage ? { kind: d.failureKind, message: d.failureMessage, nextAction: d.nextAction } : null,
    approval: d.approval ? { status: d.approval.status, tag: d.approval.tag, expiresAt: d.approval.expiresAt, requestedBy: d.approval.requestedBy } : null,
    attempts: d.attempts.map((a) => ({ kind: a.kind, status: a.status, message: a.message, at: a.startedAt })),
    updatedAt: d.updatedAt,
  };
}

/** The short form for lists and for polling a status. */
export function platformDraftStatusView(d: PlatformDraftDTO) {
  const view = platformDraftView(d);
  return {
    id: view.id,
    articleId: view.articleId,
    platform: view.platform,
    status: view.status,
    statusMeaning: view.statusMeaning,
    stale: view.stale,
    title: d.payload.title,
    hasLintErrors: view.hasLintErrors,
    remoteUrl: view.remoteUrl,
    failure: view.failure,
    approval: view.approval,
    updatedAt: view.updatedAt,
  };
}

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

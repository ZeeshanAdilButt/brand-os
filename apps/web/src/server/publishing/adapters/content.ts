import { PLATFORMS, type PlatformId } from '../../../lib/catalog';
import type { DraftExtras, DraftPayload, LintIssue, TagReport } from '../../../lib/publishing';
import {
  adaptShortText,
  adaptVideoDescription,
  chapterProblems,
  firstSentence,
  hashtagsIn,
  keyPoints,
  linksIn,
  splitPosts,
  toHashtag,
} from '../../../lib/short-form';
import { PlatformError } from '../errors';
import { analyzeBody, lintPayload } from '../lint';
import { sanitizeTags } from '../tags';
import type { AdaptInput, PlatformAdapter } from './types';

/**
 * Adapters for destinations the app cannot send to. They do the two jobs that need no connection: adapt the
 * article into the shape that destination takes (a short post, a link submission, a video description, a
 * long article) and check it against that destination's limits. Every method that would reach the platform
 * refuses, so nothing can be sent by any route even if a caller skips the checks above.
 */

const trimTags = (original: string[], max: number): TagReport => {
  const report = sanitizeTags(original, (raw) => raw.replace(/^#/, '').trim());
  return { ...report, changes: report.sent.length > max ? [...report.changes, `This destination uses at most ${max} tags; ${report.sent.length} are set.`] : report.changes };
};

function adaptFor(platform: PlatformId, input: AdaptInput): { payload: DraftPayload; tagReport: TagReport } {
  const info = PLATFORMS[platform];
  const base = { title: input.title.trim(), description: input.description.trim(), canonicalUrl: input.canonicalUrl, coverImageUrl: input.coverImageUrl };

  if (info.kind === 'short_form') {
    const { text, hashtags, notes } = adaptShortText(platform, { title: input.title, description: input.description, tags: input.tags, canonicalUrl: input.canonicalUrl, bodyMarkdown: input.bodyMarkdown });
    const kept = notes.filter((n) => n.startsWith('Kept the first'));
    return { payload: { ...base, tags: hashtags, series: null, bodyMarkdown: text }, tagReport: { original: [...input.tags], sent: hashtags, changes: kept } };
  }
  if (platform === 'hackernews') {
    return { payload: { ...base, description: '', tags: [], series: null, bodyMarkdown: '' }, tagReport: { original: [...input.tags], sent: [], changes: input.tags.length ? ['Hacker News has no tags.'] : [] } };
  }
  if (platform === 'reddit') {
    const hook = input.description.trim() || firstSentence(input.bodyMarkdown);
    const points = keyPoints(input.bodyMarkdown, 3);
    const body = [hook, points.length ? points.map((p) => `- ${p}`).join('\n') : '', input.canonicalUrl ? `Full write-up: ${input.canonicalUrl}` : ''].filter(Boolean).join('\n\n');
    return { payload: { ...base, tags: [], series: null, bodyMarkdown: body }, tagReport: { original: [...input.tags], sent: [], changes: input.tags.length ? ['Reddit has no tags.'] : [] } };
  }
  if (info.kind === 'video') {
    const tagReport = trimTags(input.tags, info.limits.tagsMax ?? 15);
    return {
      payload: { ...base, tags: tagReport.sent, series: null, bodyMarkdown: adaptVideoDescription({ title: input.title, description: input.description, tags: input.tags, canonicalUrl: input.canonicalUrl, bodyMarkdown: input.bodyMarkdown }) },
      tagReport,
    };
  }
  if (platform === 'substack') {
    const footer = input.canonicalUrl && input.bodyMarkdown.trim() ? `\n\n---\n\n*Originally published at ${input.canonicalUrl}.*\n` : '';
    return { payload: { ...base, tags: [], series: null, bodyMarkdown: `${input.bodyMarkdown.replace(/\s+$/, '')}${footer}` }, tagReport: { original: [...input.tags], sent: [], changes: input.tags.length ? ['Substack posts do not take tags here.'] : [] } };
  }
  // Medium, and the personal site's body.
  const max = info.limits.tagsMax ?? 50;
  const tagReport = trimTags(input.tags, max);
  const eol = input.bodyMarkdown.replace(/\r\n?/g, '\n');
  return {
    payload: { ...base, tags: tagReport.sent, series: input.series?.trim() ? input.series.trim() : null, bodyMarkdown: `${eol.replace(/\s+$/, '')}${eol.trim() ? '\n' : ''}` },
    tagReport,
  };
}

const issue = (code: string, severity: LintIssue['severity'], message: string, items?: string[]): LintIssue => ({ code, severity, message, ...(items ? { items } : {}) });

/** The problems with this payload for this destination: length, links, hashtags, images. Errors block approval. */
export function lintContent(platform: PlatformId, payload: DraftPayload, extras: DraftExtras = {}): LintIssue[] {
  const info = PLATFORMS[platform];
  const limits = info.limits;
  const issues: LintIssue[] = [];
  const body = payload.bodyMarkdown;

  if (info.kind === 'short_form') {
    if (!body.trim()) issues.push(issue('body_empty', 'error', 'The post has no text.'));
    const posts = splitPosts(platform, body);
    const unit = limits.unit === 'graphemes' ? 'graphemes' : 'characters';
    const over = posts.map((p, i) => ({ p, i })).filter(({ p }) => p.over);
    if (over.length > 0) {
      issues.push(
        issue(
          'post_too_long',
          'error',
          `${over.length === 1 && posts.length === 1 ? 'The post is' : `Post ${over[0]!.i + 1} is`} ${over[0]!.p.count} ${unit} and ${info.name} allows ${limits.body}. ${limits.thread ? 'Shorten it or split it with a line that holds only ---.' : 'Shorten it.'}`,
        ),
      );
    }
    if (posts.length > 1 && limits.thread) issues.push(issue('thread', 'warning', `This is ${posts.length} posts in a thread. Each is counted on its own.`));
    const withLinks = posts.filter((p) => linksIn(p.text).length > 0).length;
    if (platform === 'x' && withLinks > 1) issues.push(issue('x_link_cost', 'warning', `${withLinks} posts contain a link. X charges $0.20 for each post with a link through its API, against $0.015 without. Keep the link in one post.`));
    if (withLinks === 0 && payload.canonicalUrl) issues.push(issue('no_link', 'warning', 'The text does not contain the canonical link, so readers have no way back to your site.'));
    const tags = hashtagsIn(body);
    if (limits.tagsMax !== null && tags.length > limits.tagsMax) {
      issues.push(issue('hashtags_many', 'warning', `${tags.length} hashtags. ${info.name} reads best with ${limits.tagsMax} or fewer.`, tags));
    }
    if (platform === 'threads' && tags.length > 1) issues.push(issue('threads_topic', 'warning', 'Threads keeps one topic tag per post. Only the first hashtag is used.', tags));
    if (platform === 'mastodon') {
      const bad = tags.filter((t) => /[^#\p{L}\p{N}_]/u.test(t));
      if (bad.length > 0) issues.push(issue('hashtag_form', 'warning', 'Mastodon hashtags are letters, numbers and underscores only.', bad));
      if (!extras.options?.instance) issues.push(issue('instance_missing', 'warning', 'Set your instance in the destination options to get a share link. The character limit is the instance’s own: 500 is only the default.'));
    }
    if (platform === 'linkedin' && payload.canonicalUrl && !payload.coverImageUrl) {
      issues.push(issue('card_image', 'warning', 'LinkedIn builds the link card from the page’s own preview image. Check that your page sets one.'));
    }
    return withCover(issues, payload, info.name);
  }

  if (platform === 'hackernews') {
    if (!payload.title.trim()) issues.push(issue('title_empty', 'error', 'The title is empty.'));
    const titleLength = [...payload.title].length;
    if (titleLength > 80) issues.push(issue('title_long', 'error', `The title is ${titleLength} characters and Hacker News allows 80. Shorten it without changing its meaning.`));
    if (!payload.canonicalUrl) issues.push(issue('url_missing', 'error', 'A Hacker News submission needs a link. Set the canonical URL.'));
    else if (!/^https:\/\//i.test(payload.canonicalUrl)) issues.push(issue('url_insecure', 'warning', 'The link is not https.'));
    if (body.trim()) issues.push(issue('text_and_link', 'warning', 'Hacker News takes a link or text, not both. When both are sent, the link is used and the text is ignored.'));
    if (/^[A-Z0-9\s\p{P}]{12,}$/u.test(payload.title)) issues.push(issue('title_caps', 'warning', 'The title is in capitals. Hacker News moderators change that.'));
    return issues;
  }

  if (platform === 'reddit') {
    if (!payload.title.trim()) issues.push(issue('title_empty', 'error', 'The title is empty.'));
    if ([...payload.title].length > (limits.title ?? 300)) issues.push(issue('title_long', 'error', `The title is over ${limits.title} characters.`));
    if ([...body].length > (limits.body ?? 40_000)) issues.push(issue('body_long', 'error', `The body is over ${limits.body?.toLocaleString('en')} characters.`));
    const sub = extras.options?.subreddit?.replace(/^r\//i, '').trim() ?? '';
    if (!sub) issues.push(issue('subreddit_missing', 'warning', 'Set the subreddit in the destination options. Each one has its own rules about self-promotion: read them first.'));
    else if (!/^[A-Za-z0-9_]{2,21}$/.test(sub)) issues.push(issue('subreddit_form', 'error', 'A subreddit name is 2 to 21 letters, numbers or underscores.'));
    if (!body.trim() && !payload.canonicalUrl) issues.push(issue('body_empty', 'error', 'Add a body or a canonical link: a post needs one of them.'));
    return issues;
  }

  if (info.kind === 'video') {
    if (!payload.title.trim()) issues.push(issue('title_empty', 'error', 'The title is empty.'));
    if ([...payload.title].length > (limits.title ?? 100)) issues.push(issue('title_long', 'error', `The title is over ${limits.title} characters.`));
    if ([...body].length > (limits.body ?? 5000)) issues.push(issue('description_long', 'error', `The description is over ${limits.body?.toLocaleString('en')} characters.`));
    for (const problem of chapterProblems(body)) issues.push(issue('chapters', 'warning', problem));
    const tagChars = payload.tags.join('').length;
    if (tagChars > 500) issues.push(issue('tags_long', 'warning', 'YouTube allows 500 characters of tags in total.'));
    if (hashtagsIn(body).length > 15) issues.push(issue('hashtags_many', 'warning', 'YouTube ignores all hashtags when a video has more than 15.'));
    issues.push(issue('no_video', 'warning', 'There is no video yet. This is the metadata only: the upload is not built.'));
    if (!payload.coverImageUrl) issues.push(issue('thumbnail', 'warning', 'No thumbnail address is set. YouTube needs a custom thumbnail to be uploaded in Studio.'));
    return withCover(issues, payload, info.name);
  }

  // Long-form: Medium, Substack. Local images and private links matter less (you paste by hand) but are still shown.
  const found = analyzeBody(body);
  const generic = lintPayload(payload, { hasLocalCover: false, maxBodyChars: Number.MAX_SAFE_INTEGER, platformName: info.name });
  issues.push(...generic);
  if (limits.title !== null && [...payload.title].length > limits.title) {
    issues.push(issue('title_long', 'warning', `The title is ${[...payload.title].length} characters. ${info.name} ignores titles over ${limits.title} through its API and may cut it in the editor.`));
  }
  if (limits.tagsMax !== null && payload.tags.length > limits.tagsMax) {
    issues.push(issue('tags_too_many', 'warning', `${info.name} uses at most ${limits.tagsMax} tags. The rest are ignored.`, payload.tags));
  }
  if (platform === 'medium' && /^\s*\|.*\|\s*$/m.test(body) && /^\s*\|?\s*:?-{3,}/m.test(body)) {
    issues.push(issue('tables_unsupported', 'warning', 'Medium does not support tables. Use an image or a code block.'));
  }
  if (platform === 'medium' && found.hasMermaid) issues.push(issue('mermaid_unsupported', 'warning', 'Mermaid diagrams are not drawn on Medium. Use an image.'));
  if (platform === 'substack') issues.push(issue('no_canonical_field', 'warning', 'Substack has no canonical field: the post canonicalizes to itself. Publish on your site first and let it be indexed.'));
  return issues;
}

/** A cover address for a short post is a link-card image: it must be a public https address. */
function withCover(issues: LintIssue[], payload: DraftPayload, name: string): LintIssue[] {
  if (payload.coverImageUrl && !/^https:\/\//i.test(payload.coverImageUrl)) {
    issues.push(issue('cover_not_public', 'error', `The ${name} image must be a public https URL.`, [payload.coverImageUrl]));
  }
  return issues;
}

function refuse(platform: PlatformId): never {
  throw new PlatformError('config', `${PLATFORMS[platform].name} cannot be reached by this app. Preview it and post it by hand.`, { notSent: true });
}

/** An adapter for a destination without a connector. It adapts and checks; it cannot send. */
export function contentAdapter(platform: PlatformId): PlatformAdapter {
  const info = PLATFORMS[platform];
  return {
    id: platform,
    info,
    adapt: (input) => adaptFor(platform, input),
    validate: (payload, extras) => lintContent(platform, payload, extras),
    tags: (original) => {
      if (info.kind === 'short_form') return sanitizeTags(original, (raw) => toHashtag(raw));
      return trimTags(original, info.limits.tagsMax ?? 50);
    },
    preview: (payload) => ({ note: `Nothing is sent to ${info.name}. Copy it and post it by hand.`, title: payload.title, text: payload.bodyMarkdown, link: payload.canonicalUrl }),
    health: async () => refuse(platform),
    stage: async () => refuse(platform),
    publish: async () => refuse(platform),
    check: async () => refuse(platform),
  };
}

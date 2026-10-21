import { PLATFORMS, type PlatformId } from './catalog';
import type { DraftExtras, DraftPayload } from './publishing';
import { chaptersIn, foldText, linksIn, splitPosts } from './short-form';

/**
 * A plain-text rendering of how a draft will look on its destination, for places that cannot draw the real
 * preview: the agent API and the MCP server. The composer draws richer, still approximate, previews from the same
 * numbers. It says what is counted and where a feed would cut the text, and it is never a promise of how the
 * platform will lay it out.
 */

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function previewText(platform: PlatformId, payload: DraftPayload, extras: DraftExtras = {}): string {
  const info = PLATFORMS[platform];
  const lines: string[] = [`Approximate preview of ${info.name}. The platform’s own layout may differ.`, ''];

  if (info.kind === 'short_form') {
    const posts = splitPosts(platform, payload.bodyMarkdown);
    const unit = info.limits.unit === 'graphemes' ? 'graphemes' : 'characters';
    posts.forEach((post, i) => {
      lines.push(`${posts.length > 1 ? `Post ${i + 1} of ${posts.length}` : 'Post'} (${post.count}${post.limit ? ` of ${post.limit}` : ''} ${unit}${post.over ? ', TOO LONG' : ''})`);
      if (info.limits.fold && posts.length === 1) {
        const { shown, hidden } = foldText(post.text, info.limits.fold);
        lines.push(shown + (hidden ? ' … see more' : ''));
        if (hidden) lines.push(`(the feed cuts the text after about ${info.limits.fold} characters; ${hidden.length} more are behind “see more”)`);
      } else {
        lines.push(post.text);
      }
      lines.push('');
    });
    const links = linksIn(payload.bodyMarkdown);
    lines.push(`Links in the text: ${links.length}`);
    return lines.join('\n');
  }

  if (info.kind === 'link_submission') {
    const titleLength = [...payload.title].length;
    lines.push(`Title (${titleLength}${info.limits.title ? ` of ${info.limits.title}` : ''} characters): ${payload.title}`);
    if (payload.canonicalUrl) lines.push(`Link: ${payload.canonicalUrl}`);
    if (platform === 'reddit') lines.push(`Subreddit: ${extras.options?.subreddit ? `r/${extras.options.subreddit.replace(/^r\//i, '')}` : '(not set)'}`);
    if (payload.bodyMarkdown.trim()) lines.push('', clip(payload.bodyMarkdown, 600));
    return lines.join('\n');
  }

  if (info.kind === 'video') {
    lines.push(`Title (${[...payload.title].length}${info.limits.title ? ` of ${info.limits.title}` : ''} characters): ${payload.title}`);
    const { shown, hidden } = foldText(payload.bodyMarkdown, info.limits.fold);
    lines.push('', 'Description (the first lines show before “Show more”):', shown + (hidden ? ' …' : ''));
    const chapters = chaptersIn(payload.bodyMarkdown);
    lines.push('', chapters.length ? `Chapters: ${chapters.length}` : 'Chapters: none');
    if (payload.tags.length) lines.push(`Tags: ${payload.tags.join(', ')}`);
    lines.push('No video is attached: this is the metadata only.');
    return lines.join('\n');
  }

  lines.push(`Title: ${payload.title}`);
  if (payload.description) lines.push(`${platform === 'substack' ? 'Subtitle' : 'Description'}: ${payload.description}`);
  if (payload.tags.length) lines.push(`Tags: ${payload.tags.join(', ')}`);
  if (payload.canonicalUrl) lines.push(`Canonical: ${payload.canonicalUrl}`);
  lines.push('', clip(payload.bodyMarkdown, 800));
  return lines.join('\n');
}

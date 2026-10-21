import { PLATFORMS, type PlatformId, type SubmitLinkKind } from './catalog';
import { chaptersIn, splitPosts } from './short-form';
import type { DraftPayload } from './publishing';
import type { DraftExtras } from './site-export';

/**
 * Posting by hand, for every platform: the kit to copy (title, body, metadata in the form that platform takes),
 * a pre-filled link where the platform has one, and the check a recorded link has to pass. Pure, so the composer
 * and the server use the same rules. Opening a link here sends nothing: it only opens the platform's own page.
 */

export interface ManualContext {
  /** The site's host, from the personal-site settings. Needed to check a link recorded for the site. */
  siteHost: string | null;
  /** "owner/name" and the base branch, for the GitHub new-file link. */
  siteRepo?: string | null;
  siteBase?: string | null;
  sitePath?: string | null;
  /** The finished Markdown file for the personal site, with its front matter. */
  siteFile?: string | null;
}

export interface KitPart {
  label: string;
  value: string;
}

export interface ManualKit {
  platform: PlatformId;
  /** Everything as one block of text, labelled, for a single copy. */
  all: string;
  /** The same, split into the pieces the platform asks for separately. */
  parts: KitPart[];
  openUrl: string;
  openLabel: string;
  /** A pre-filled link, or null when the platform has none (or not enough is known to build one). */
  submitUrl: string | null;
  submitNote: string | null;
  steps: string[];
}

const MAX_LINK = 1900;
const enc = encodeURIComponent;

function submitLink(kind: SubmitLinkKind, payload: DraftPayload, platform: PlatformId, extras: DraftExtras, ctx: ManualContext): { url: string | null; note: string | null } {
  const posts = splitPosts(platform, payload.bodyMarkdown);
  const firstPost = posts[0]?.text ?? '';
  const link = payload.canonicalUrl;
  switch (kind) {
    case 'hackernews': {
      if (!link) return { url: null, note: 'Hacker News needs a link. Set the canonical URL first.' };
      return { url: `https://news.ycombinator.com/submitlink?u=${enc(link)}&t=${enc(payload.title)}`, note: 'Opens the submit page with the title and link filled in. You submit it.' };
    }
    case 'reddit': {
      const sub = extras.options?.subreddit?.replace(/^r\//i, '').trim();
      const base = sub ? `https://www.reddit.com/r/${enc(sub)}/submit` : 'https://www.reddit.com/submit';
      const self = payload.bodyMarkdown.trim().length > 0;
      const params = [`type=${self ? 'self' : 'link'}`, `title=${enc(payload.title)}`, !self && link ? `url=${enc(link)}` : '', self ? `text=${enc(payload.bodyMarkdown)}` : ''].filter(Boolean).join('&');
      const full = `${base}?${params}`;
      if (full.length > MAX_LINK) return { url: `${base}?type=self&title=${enc(payload.title)}`, note: 'The text is too long to pre-fill: paste the copied body into the post.' };
      return { url: full, note: sub ? `Opens r/${sub}'s submit page. Read its rules first.` : 'Opens Reddit’s submit page. Pick the subreddit there, and read its rules first.' };
    }
    case 'x': {
      const url = `https://x.com/intent/post?text=${enc(firstPost)}`;
      return { url, note: posts.length > 1 ? 'Pre-fills the first post only. Post the rest as replies, one at a time.' : 'Opens the compose box with the text filled in. You post it.' };
    }
    case 'linkedin': {
      if (!link) return { url: null, note: 'LinkedIn’s share link needs the canonical URL.' };
      return { url: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(link)}`, note: 'LinkedIn fills in only the link. Paste the copied text above it.' };
    }
    case 'bluesky':
      return { url: `https://bsky.app/intent/compose?text=${enc(firstPost)}`, note: 'Opens the compose box with the text filled in. You post it.' };
    case 'threads':
      return { url: `https://www.threads.com/intent/post?text=${enc(firstPost)}`, note: 'Opens the compose box with the text filled in. The Threads intent address is unverified.' };
    case 'mastodon': {
      const instance = extras.options?.instance?.trim();
      if (!instance || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(instance)) return { url: null, note: 'Set your instance address in the destination options to get a share link.' };
      return { url: `https://${instance}/share?text=${enc(firstPost)}`, note: 'Opens your instance’s compose box with the text filled in.' };
    }
    case 'github': {
      if (!ctx.siteRepo || !ctx.sitePath) return { url: null, note: 'Set the repository and path in Settings > Connections to get a link.' };
      return { url: `https://github.com/${ctx.siteRepo}/new/${enc(ctx.siteBase ?? 'main')}?filename=${enc(ctx.sitePath)}`, note: 'Opens GitHub’s new-file page for the path. Paste the copied file into it. This is your own commit; the app does not make it.' };
    }
  }
}

function labelled(parts: KitPart[]): string {
  return parts.map((p) => (p.value ? `${p.label}\n${p.value}` : '')).filter(Boolean).join('\n\n');
}

/** The kit for posting this draft by hand. */
export function buildManualKit(platform: PlatformId, payload: DraftPayload, extras: DraftExtras, ctx: ManualContext = { siteHost: null }): ManualKit {
  const info = PLATFORMS[platform];
  const parts: KitPart[] = [];
  const tags = payload.tags.length ? payload.tags.join(', ') : '';
  if (info.kind === 'short_form') {
    const posts = splitPosts(platform, payload.bodyMarkdown);
    posts.forEach((post, i) => parts.push({ label: posts.length > 1 ? `Post ${i + 1} of ${posts.length}` : 'Post', value: post.text }));
  } else if (info.kind === 'link_submission') {
    parts.push({ label: 'Title', value: payload.title });
    parts.push({ label: 'Link', value: payload.canonicalUrl ?? '' });
    if (payload.bodyMarkdown.trim()) parts.push({ label: platform === 'reddit' ? 'Body' : 'Text', value: payload.bodyMarkdown });
    if (platform === 'reddit' && extras.options?.subreddit) parts.push({ label: 'Subreddit', value: `r/${extras.options.subreddit.replace(/^r\//i, '')}` });
  } else if (info.kind === 'video') {
    parts.push({ label: 'Title', value: payload.title });
    parts.push({ label: 'Description', value: payload.bodyMarkdown });
    parts.push({ label: 'Tags', value: tags });
  } else if (platform === 'site' && ctx.siteFile) {
    if (ctx.sitePath) parts.push({ label: 'File path', value: ctx.sitePath });
    parts.push({ label: 'File (front matter and body)', value: ctx.siteFile });
  } else {
    parts.push({ label: 'Title', value: payload.title });
    if (payload.description) parts.push({ label: platform === 'substack' ? 'Subtitle' : 'Description', value: payload.description });
    parts.push({ label: 'Tags', value: tags });
    parts.push({ label: 'Canonical URL', value: payload.canonicalUrl ?? '' });
    if (payload.coverImageUrl) parts.push({ label: 'Cover image', value: payload.coverImageUrl });
    if (payload.series) parts.push({ label: 'Series', value: payload.series });
    parts.push({ label: 'Body (Markdown)', value: payload.bodyMarkdown });
  }
  const cleaned = parts.filter((p) => p.value.trim() !== '');
  const submit = info.manual.submitLink ? submitLink(info.manual.submitLink, payload, platform, extras, ctx) : { url: null, note: null };
  return {
    platform,
    all: labelled(cleaned),
    parts: cleaned,
    openUrl: info.manual.openUrl,
    openLabel: info.manual.openLabel,
    submitUrl: submit.url,
    submitNote: submit.note,
    steps: info.manual.steps,
  };
}

export type ManualUrlResult = { ok: true; url: string; host: string } | { ok: false; reason: string };

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
  return host === pattern;
}

/**
 * A recorded link has to be a plain https address on a host that platform really uses. This does not prove the
 * post exists (the app never fetches it); it stops a mistyped or unrelated address from being recorded as the post.
 */
export function validateManualUrl(platform: PlatformId, raw: string, ctx: ManualContext = { siteHost: null }): ManualUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'Enter the full address of the post, starting with https://.' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'The address must start with https://.' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'The address must not contain a user name or password.' };
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'That is not a public web address.' };
  }
  const info = PLATFORMS[platform];

  if (platform === 'site') {
    if (!ctx.siteHost) return { ok: false, reason: 'Set your site’s address in Settings > Connections first, so the link can be checked against it.' };
    const site = ctx.siteHost.toLowerCase().replace(/^www\./, '');
    if (host.replace(/^www\./, '') !== site) return { ok: false, reason: `That address is not on your site (${ctx.siteHost}).` };
    return { ok: true, url: parsed.toString(), host };
  }
  if (platform === 'mastodon') {
    // Instances are everywhere. A toot link has /@name/<digits> or /users/name/statuses/<digits>.
    if (!/\/@[^/]+\/\d+\/?$/.test(parsed.pathname) && !/\/users\/[^/]+\/statuses\/\d+\/?$/.test(parsed.pathname)) {
      return { ok: false, reason: 'A Mastodon post address looks like https://your.instance/@you/123456789.' };
    }
    return { ok: true, url: parsed.toString(), host };
  }
  if (!info.manual.hosts.some((pattern) => hostMatches(host, pattern))) {
    return { ok: false, reason: `That address is not on ${info.manual.hosts.filter((h) => !h.startsWith('*.')).join(' or ') || info.name}. Enter the link of the post itself.` };
  }
  if (platform === 'hackernews' && !(parsed.pathname === '/item' && /^\d+$/.test(parsed.searchParams.get('id') ?? ''))) {
    return { ok: false, reason: 'A Hacker News submission address looks like https://news.ycombinator.com/item?id=12345.' };
  }
  return { ok: true, url: parsed.toString(), host };
}

/** True when a YouTube description already carries chapters. */
export function hasChapters(description: string): boolean {
  return chaptersIn(description).length > 0;
}

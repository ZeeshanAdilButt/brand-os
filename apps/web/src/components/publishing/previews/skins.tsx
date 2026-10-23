'use client';

import { Heart, MessageCircle, Repeat2, Send, Share, ThumbsUp, Bookmark } from 'lucide-react';
import type { ReactNode } from 'react';
import { PLATFORMS, type PlatformId } from '@/lib/catalog';
import type { DraftPayload } from '@/lib/publishing';
import { chaptersIn, foldText, linksIn, splitPosts } from '@/lib/short-form';
import { cn } from '@/lib/utils';
import { Sim, type Appearance, type Device } from './preview-frame';
import { useRenderedMarkdown } from './use-rendered';

export interface SkinProps {
  platform: PlatformId;
  payload: DraftPayload;
  account: string | null;
  device: Device;
  appearance: Appearance;
  /** Where the personal site lives, for the "originally published" line and link cards. */
  subreddit?: string | undefined;
}

export const hostOf = (url: string | null): string | null => {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return null;
  }
};

const readingMinutes = (text: string) => Math.max(1, Math.round((text.match(/[\p{L}\p{N}']+/gu) ?? []).length / 200));

/** Text with links, hashtags and mentions picked out, as a platform would colour them. Nothing here is a real link. */
export function PostText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|#[\p{L}\p{N}_]+|@[A-Za-z0-9_.]+)/gu);
  return (
    <p className="sim-post-text">
      {parts.map((part, i) => (i % 2 === 1 ? <span key={i} className="sim-link">{part}</span> : <span key={i}>{part}</span>))}
    </p>
  );
}

function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <span aria-hidden className="sim-avatar" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {(name.replace(/^@/, '')[0] ?? '?').toUpperCase()}
    </span>
  );
}

function MockBar({ icons }: { icons: ReactNode[] }) {
  return (
    <div aria-hidden className="sim-mock">
      {icons}
    </div>
  );
}

function LinkCard({ payload, compact }: { payload: DraftPayload; compact?: boolean }) {
  const host = hostOf(payload.canonicalUrl);
  if (!host) return null;
  return (
    <div className="sim-card mt-3">
      <div className={cn('sim-placeholder', compact ? 'h-24' : 'h-32')}>The card image comes from your page’s own preview image.</div>
      <div className="px-3 py-2">
        <p className="sim-muted text-xs">{host}</p>
        <p className="line-clamp-2 font-semibold">{payload.title || 'Untitled'}</p>
        {payload.description ? <p className="sim-muted line-clamp-2 text-xs">{payload.description}</p> : null}
      </div>
    </div>
  );
}

const SOCIAL: Partial<Record<PlatformId, { accent: string; sub: string; handle?: string; mock: ReactNode[]; fold?: { desktop: number; mobile: number } }>> = {
  linkedin: {
    accent: '#0a66c2',
    sub: 'Your headline',
    fold: { desktop: 210, mobile: 140 },
    mock: [
      <span key="l" className="inline-flex items-center gap-1"><ThumbsUp className="size-3.5" />Like</span>,
      <span key="c" className="inline-flex items-center gap-1"><MessageCircle className="size-3.5" />Comment</span>,
      <span key="r" className="inline-flex items-center gap-1"><Repeat2 className="size-3.5" />Repost</span>,
      <span key="s" className="inline-flex items-center gap-1"><Send className="size-3.5" />Send</span>,
    ],
  },
  x: {
    accent: '#1d9bf0',
    sub: '@yourhandle',
    mock: [
      <MessageCircle key="c" className="size-3.5" />,
      <Repeat2 key="r" className="size-3.5" />,
      <Heart key="l" className="size-3.5" />,
      <Share key="s" className="size-3.5" />,
    ],
  },
  bluesky: {
    accent: '#0085ff',
    sub: '@you.bsky.social',
    mock: [<MessageCircle key="c" className="size-3.5" />, <Repeat2 key="r" className="size-3.5" />, <Heart key="l" className="size-3.5" />],
  },
  threads: {
    accent: '#101010',
    sub: 'yourname',
    mock: [<Heart key="l" className="size-3.5" />, <MessageCircle key="c" className="size-3.5" />, <Repeat2 key="r" className="size-3.5" />, <Send key="s" className="size-3.5" />],
  },
  mastodon: {
    accent: '#6364ff',
    sub: '@you@your.instance',
    mock: [<MessageCircle key="c" className="size-3.5" />, <Repeat2 key="r" className="size-3.5" />, <Heart key="l" className="size-3.5" />, <Bookmark key="b" className="size-3.5" />],
  },
};

/** LinkedIn, X, Bluesky, Threads and Mastodon: the post as it sits in a feed, or opened with every post of a thread. */
export function SocialSkin({ platform, payload, account, device, appearance, mode, showFull }: SkinProps & { mode: 'feed' | 'opened'; showFull: boolean }) {
  const config = SOCIAL[platform]!;
  const name = account && !account.startsWith('@') ? account : 'Your name';
  const posts = splitPosts(platform, payload.bodyMarkdown);
  const info = PLATFORMS[platform];
  const isLinkedIn = platform === 'linkedin';
  const foldAt = isLinkedIn && config.fold ? config.fold[device] : null;
  const feedMode = mode === 'feed';
  const visiblePosts = feedMode && !isLinkedIn ? posts.slice(0, 1) : posts;

  return (
    <Sim device={device} appearance={appearance} skin={platform} kind="feed" accent={config.accent} label={`${info.name} post, approximate`}>
      <div className="p-4">
        {visiblePosts.map((post, index) => {
          const folded = isLinkedIn && feedMode && !showFull ? foldText(post.text, foldAt) : { shown: post.text, hidden: '' };
          const last = index === visiblePosts.length - 1;
          return (
            <article key={index} className={cn('flex gap-3', !last && 'pb-4')} aria-label={posts.length > 1 ? `Post ${index + 1} of ${posts.length}` : 'Post'}>
              <div className="flex flex-col items-center">
                <Avatar name={name} size={isLinkedIn ? 48 : 40} />
                {!last ? <span aria-hidden className="mt-1 w-0.5 flex-1 bg-[var(--sim-border)]" /> : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {name} <span className="sim-muted font-normal">{config.sub}</span>
                </p>
                {isLinkedIn ? <p className="sim-muted text-xs">Now · placeholder</p> : null}
                <div className="mt-1.5">
                  <PostText text={folded.shown} />
                  {folded.hidden ? <span className="sim-muted"> …<span className="sim-link font-semibold"> see more</span></span> : null}
                </div>
                {index === 0 && (!feedMode || isLinkedIn || platform === 'x') && linksIn(payload.bodyMarkdown).length > 0 ? <LinkCard payload={payload} compact={device === 'mobile'} /> : null}
                {feedMode && !isLinkedIn && posts.length > 1 ? <p className="sim-link mt-2 text-sm">Show this thread ({posts.length} posts)</p> : null}
                {last ? <MockBar icons={config.mock} /> : null}
              </div>
            </article>
          );
        })}
      </div>
    </Sim>
  );
}

/** What the counters under a short post say: each post against its own limit, in the platform’s own unit. */
export function Counters({ platform, payload }: { platform: PlatformId; payload: DraftPayload }) {
  const info = PLATFORMS[platform];
  const posts = splitPosts(platform, payload.bodyMarkdown);
  const unit = info.limits.unit === 'graphemes' ? 'graphemes' : info.limits.unit === 'x_weighted' ? 'characters (links count as 23)' : 'characters';
  return (
    <ul className="grid gap-0.5" aria-label="Length of each post">
      {posts.map((post, i) => {
        const limit = post.limit;
        const ratio = limit ? post.count / limit : 0;
        return (
          <li key={i} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-foreground">{posts.length > 1 ? `Post ${i + 1}` : 'Post'}</span>
            <span className={cn(post.over ? 'font-semibold text-danger' : ratio > 0.9 ? 'font-medium text-warning' : '')}>
              {post.count.toLocaleString('en')}
              {limit ? ` of ${limit.toLocaleString('en')}` : ''} {unit}
              {post.over ? ` (${(post.count - (limit ?? 0)).toLocaleString('en')} over)` : limit ? `, ${(limit - post.count).toLocaleString('en')} left` : ''}
            </span>
          </li>
        );
      })}
      {info.limits.fold ? <li>The feed cuts the text after about {info.limits.fold} characters on a desktop and fewer on a phone. This is an estimate.</li> : null}
      {info.unverified.length > 0 ? <li>Limit not fully verified: {info.unverified[0]}</li> : null}
    </ul>
  );
}

/** A long article page: cover, title, byline, tags and the rendered body, in the typography of the platform. */
export function ArticleSkin({ platform, payload, account, device, appearance, view }: SkinProps & { view?: 'inbox' | 'opened' }) {
  const rendered = useRenderedMarkdown(payload.bodyMarkdown);
  const info = PLATFORMS[platform];
  const name = account && !account.startsWith('@') && !account.includes('/') ? account : 'Your name';
  const accent: Partial<Record<PlatformId, string>> = { devto: '#3b49df', hashnode: '#2962ff', medium: '#1a8917', substack: '#ff6719', site: '#12372a' };
  const canonicalHost = hostOf(payload.canonicalUrl);
  const minutes = readingMinutes(payload.bodyMarkdown);

  if (platform === 'substack' && view === 'inbox') {
    return (
      <Sim device={device} appearance={appearance} skin="substack" kind="feed" accent={accent.substack ?? '#ff6719'} label="Substack inbox, approximate">
        <div className="divide-y divide-[var(--sim-border)]">
          <div className="flex gap-3 p-4">
            <Avatar name={name} />
            <div className="min-w-0">
              <p className="font-semibold">Your publication</p>
              <p className="truncate font-semibold">{payload.title || 'Untitled'}</p>
              <p className="sim-muted line-clamp-2">{payload.description || 'The first lines of the post appear here when there is no subtitle.'}</p>
            </div>
          </div>
        </div>
      </Sim>
    );
  }

  return (
    <Sim device={device} appearance={appearance} skin={platform} kind="article" accent={accent[platform]} label={`${info.name} article, approximate`}>
      <div className="flex items-center gap-2 border-b border-[var(--sim-border)] px-4 py-2 text-xs font-semibold">
        <span className="rounded px-1.5 py-0.5 text-white" style={{ background: 'var(--sim-accent)' }}>{info.name}</span>
        <span className="sim-muted font-normal">{platform === 'hashnode' ? 'Your publication' : platform === 'site' ? hostOf(payload.canonicalUrl) ?? 'your site' : 'placeholder header'}</span>
      </div>
      <div className="sim-article">
        {payload.coverImageUrl ? <div className="sim-placeholder mb-5 h-44 rounded-lg">Cover image: {hostOf(payload.coverImageUrl) ?? 'address not valid'}. Not loaded in the preview.</div> : null}
        <h1 className="sim-title text-[2rem] leading-tight font-bold tracking-tight" style={{ overflowWrap: 'anywhere' }}>
          {payload.title || <span className="sim-muted">Untitled</span>}
        </h1>
        {payload.description ? <p className="sim-muted mt-2 text-lg leading-7">{payload.description}</p> : null}
        <div className="mt-4 flex items-center gap-3">
          <Avatar name={name} size={36} />
          <p className="text-sm">
            <span className="font-semibold">{name}</span>
            <span className="sim-muted"> · {minutes} min read</span>
          </p>
        </div>
        {payload.tags.length > 0 ? (
          <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Tags">
            {payload.tags.map((tag) => (
              <li key={tag} className="sim-card px-2 py-0.5 text-xs">
                #{tag}
              </li>
            ))}
          </ul>
        ) : null}
        {canonicalHost && platform !== 'site' ? <p className="sim-muted mt-4 border-t border-[var(--sim-border)] pt-3 text-xs">Canonical: this post is a copy of the page on {canonicalHost}.</p> : null}
        <div className="mt-6">
          {rendered.failed ? (
            <p className="sim-muted">The preview could not be drawn. The Markdown is unchanged.</p>
          ) : rendered.html === null ? (
            <p className="sim-muted">Preparing the preview…</p>
          ) : (
            <div className="sim-prose" dangerouslySetInnerHTML={{ __html: rendered.html }} />
          )}
          {rendered.notices.length > 0 ? (
            <p className="mt-4 rounded-md border border-[var(--sim-border)] p-2 text-xs sim-muted" role="status">
              {rendered.notices.reduce((sum, n) => sum + n.count, 0)} items in the Markdown were not drawn because they can run code or are not supported here.
            </p>
          ) : null}
        </div>
      </div>
    </Sim>
  );
}

/** Hacker News (a listing row, or the submit form) and Reddit (a post in a community). */
export function SubmissionSkin({ platform, payload, device, appearance, view, subreddit }: SkinProps & { view: 'listing' | 'fields' }) {
  const host = hostOf(payload.canonicalUrl);
  const info = PLATFORMS[platform];
  if (platform === 'hackernews') {
    return (
      <Sim device={device} appearance={appearance} skin="hackernews" kind="feed" accent="#ff6600" label="Hacker News submission, approximate">
        <div className="px-3 py-1.5 text-sm font-bold text-white" style={{ background: 'var(--sim-accent)' }}>
          Hacker News <span className="font-normal">(preview)</span>
        </div>
        {view === 'listing' ? (
          <div className="p-3" style={{ fontFamily: 'Verdana, Geneva, sans-serif', fontSize: 13 }}>
            <p>
              <span className="sim-muted">1.</span> <span className="font-medium">{payload.title || 'Untitled'}</span> {host ? <span className="sim-muted text-xs">({host})</span> : null}
            </p>
            <p className="sim-muted pl-5 text-xs">submitted by yourname</p>
          </div>
        ) : (
          <dl className="grid grid-cols-[4rem_1fr] gap-x-3 gap-y-2 p-4">
            <dt className="sim-muted">title</dt>
            <dd className="font-medium">{payload.title}</dd>
            <dt className="sim-muted">url</dt>
            <dd className="break-all">{payload.canonicalUrl ?? <span className="sim-muted">(none)</span>}</dd>
            <dt className="sim-muted">text</dt>
            <dd>{payload.bodyMarkdown.trim() ? payload.bodyMarkdown : <span className="sim-muted">(leave empty when you submit a link)</span>}</dd>
          </dl>
        )}
      </Sim>
    );
  }
  const community = subreddit ? `r/${subreddit.replace(/^r\//i, '')}` : 'r/choose-a-community';
  return (
    <Sim device={device} appearance={appearance} skin="reddit" kind="feed" accent="#ff4500" label={`${info.name} post, approximate`}>
      <div className="p-4">
        <div className="flex items-center gap-2 text-xs">
          <Avatar name="r" size={22} />
          <span className="font-semibold">{community}</span>
          <span className="sim-muted">· posted by u/yourname</span>
        </div>
        <h2 className="mt-2 text-lg leading-6 font-semibold" style={{ overflowWrap: 'anywhere' }}>
          {payload.title || 'Untitled'}
        </h2>
        {payload.bodyMarkdown.trim() ? <div className="mt-2"><PostText text={payload.bodyMarkdown} /></div> : null}
        {!payload.bodyMarkdown.trim() && host ? <LinkCard payload={payload} compact /> : null}
        <MockBar icons={[<span key="u" className="inline-flex items-center gap-1"><ThumbsUp className="size-3.5" />Vote</span>, <span key="c" className="inline-flex items-center gap-1"><MessageCircle className="size-3.5" />Comments</span>, <span key="s" className="inline-flex items-center gap-1"><Share className="size-3.5" />Share</span>]} />
      </div>
    </Sim>
  );
}

/** YouTube: the metadata only, since no video exists yet. */
export function VideoSkin({ payload, device, appearance, view }: SkinProps & { view: 'card' | 'watch' }) {
  const chapters = chaptersIn(payload.bodyMarkdown);
  const { shown, hidden } = foldText(payload.bodyMarkdown, 150);
  const stamp = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <Sim device={device} appearance={appearance} skin="youtube" kind={view === 'card' ? 'feed' : 'article'} accent="#ff0000" label="YouTube video metadata, approximate">
      <div className="p-4">
        <div className="sim-placeholder aspect-video w-full rounded-lg">
          <span>
            <strong className="block text-sm">No video yet</strong>
            The upload is not built. This shows the title, description and chapters only.
          </span>
        </div>
        <h2 className="mt-3 text-base leading-6 font-semibold" style={{ overflowWrap: 'anywhere' }}>
          {payload.title || 'Untitled'}
        </h2>
        <p className="sim-muted text-xs">Your channel</p>
        {view === 'watch' ? (
          <div className="sim-card mt-3 p-3">
            <p className="sim-post-text">{payload.bodyMarkdown}</p>
            {chapters.length > 0 ? (
              <ol className="mt-3 grid gap-1 border-t border-[var(--sim-border)] pt-3" aria-label="Chapters">
                {chapters.map((chapter) => (
                  <li key={chapter.seconds} className="flex gap-3">
                    <span className="sim-link w-10 shrink-0 tabular-nums">{stamp(chapter.seconds)}</span>
                    <span>{chapter.label}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            {payload.tags.length > 0 ? <p className="sim-muted mt-3 text-xs">Tags: {payload.tags.join(', ')}</p> : null}
          </div>
        ) : (
          <div className="sim-card mt-3 p-3">
            <p className="sim-post-text">{shown}{hidden ? <span className="sim-muted"> … <span className="sim-link font-semibold">Show more</span></span> : null}</p>
          </div>
        )}
      </div>
    </Sim>
  );
}

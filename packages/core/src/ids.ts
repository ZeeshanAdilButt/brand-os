export type PlatformId =
  | 'devto'
  | 'linkedin'
  | 'x'
  | 'bluesky'
  | 'mastodon'
  | 'hashnode'
  | 'medium'
  | 'substack'
  | 'reddit'
  | 'youtube';

export type RouteKind = 'direct' | 'buffer' | 'assist';

export type DraftKind = 'article' | 'post' | 'thread' | 'video' | 'newsletter' | 'assist-kit';

/**
 * `publishing` is a remote call in flight. `unknown` means a crash or timeout
 * happened after the approval was consumed; it is resolved by a startup sweep
 * or a manual check on the platform, and is never retried automatically.
 */
export type DraftStatus =
  | 'draft'
  | 'staged'
  | 'pending_approval'
  | 'approved'
  | 'scheduled'
  | 'publishing'
  | 'unknown'
  | 'published'
  | 'handed_off'
  | 'failed'
  | 'held'
  | 'source_changed';

export type Authorship = 'verbatim' | 'reformatted' | 'ai-assisted';

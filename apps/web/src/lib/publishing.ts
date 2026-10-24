/**
 * Publishing vocabulary shared by the schema, the server and the UI. No server imports.
 * Capability data lives here so the screens show exactly what each platform can and cannot do,
 * and nothing is implied beyond it. Labels and notes are user-facing copy.
 */

import { PLATFORM_IDS, PLATFORMS, RECOMMENDED_ORDER, isPlatformId, isPublishable, isSyndication, type PlatformCapabilities, type PlatformId, type PlatformInfo } from './catalog';
import type { ConnectorId } from './connectors/ids';
import type { DraftExtras } from './site-export';

export { PLATFORM_IDS, PLATFORMS, RECOMMENDED_ORDER, isPlatformId, isPublishable, isSyndication };
export type { DraftExtras, PlatformCapabilities, PlatformId, PlatformInfo };

/**
 * draft: built from an article, nothing sent. staged: a private copy exists on the platform.
 * pending_approval: waiting for the owner. approved: reserved for the instant between approving and
 * publishing (the two are one transaction, so a draft is never left here). publishing: the one
 * request is in flight. published: confirmed live. failed: the platform clearly refused, nothing
 * went out. unknown: it may or may not have gone out; resolved only by a check or by hand.
 * source_changed: the article was edited after the draft was built.
 */
export const DRAFT_STATUSES = ['draft', 'staged', 'pending_approval', 'approved', 'publishing', 'published', 'failed', 'unknown', 'source_changed'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = {
  draft: 'Draft',
  staged: 'Private draft on platform',
  pending_approval: 'Waiting for your approval',
  approved: 'Approved',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Not published (refused)',
  unknown: 'Result unknown',
  source_changed: 'Article changed',
};

export const DRAFT_STATUS_HINTS: Record<DraftStatus, string> = {
  draft: 'Prepared from the article. Nothing has been sent.',
  staged: 'A private copy exists on the platform. It is not public.',
  pending_approval: 'Review the exact payload below and approve it, or let the request expire.',
  approved: 'Approved. Publishing starts at once.',
  publishing: 'The request is being sent. Do not close this page until it finishes.',
  published: 'Live on the platform.',
  failed: 'The platform refused the request, so nothing went out. Fix the problem and ask for a new approval.',
  unknown: 'The request may or may not have gone out. Check on the platform before anything else. It will not be retried.',
  source_changed: 'The article was edited after this draft was built, so any approval is void. Rebuild the draft.',
};

/** How a published draft went out: by the app's own request, or by the owner's hand (recorded, never claimed). */
export const PUBLISHED_VIA = ['app', 'manual'] as const;
export type PublishedVia = (typeof PUBLISHED_VIA)[number];

/**
 * What the pill says. The personal site never goes "live" through the app: it opens a pull request that the owner
 * merges, so its words differ. A post recorded by hand says so.
 */
export function statusLabel(platform: PlatformId, status: DraftStatus, via: PublishedVia | null = null): string {
  if (status === 'published' && via === 'manual') return 'Posted by hand';
  if (platform === 'site') {
    if (status === 'staged') return 'Target checked';
    if (status === 'pending_approval') return 'Waiting for your approval';
    if (status === 'publishing') return 'Opening pull request';
    if (status === 'published') return 'Pull request opened';
    if (status === 'unknown') return 'Pull request unknown';
  }
  return DRAFT_STATUS_LABELS[status];
}

export function statusHint(platform: PlatformId, status: DraftStatus, via: PublishedVia | null = null): string {
  if (status === 'published' && via === 'manual') return 'You posted this by hand and recorded the link. The app did not publish it.';
  if (platform === 'site') {
    if (status === 'staged') return 'The repository was read and the target file checked. Nothing was written.';
    if (status === 'publishing') return 'The branch, the commit and the pull request are being created. Do not close this page until it finishes.';
    if (status === 'published') return 'Pull request opened; merge it in GitHub to go live.';
    if (status === 'unknown') return 'The pull request may or may not exist. Check on GitHub before anything else. It will not be retried.';
  }
  return DRAFT_STATUS_HINTS[status];
}

/** Statuses from which a draft can still reach a platform if the owner approves. */
export const LIVE_STATUSES: readonly DraftStatus[] = ['draft', 'staged', 'pending_approval', 'approved', 'failed'];
/** In flight or already out: nothing may send this payload again. */
export const ALREADY_OUT_STATUSES: readonly DraftStatus[] = ['publishing', 'unknown', 'published'];
/** The only statuses a stage result may move a draft out of. A late stage answer never touches any other. */
export const STAGEABLE_STATUSES: readonly DraftStatus[] = ['draft', 'staged', 'failed'];

export const APPROVAL_STATUSES = ['pending', 'used', 'denied', 'expired', 'invalidated'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** What an approval is for: sending the exact payload to the platform, or recording that the owner posted it by hand. */
export const APPROVAL_KINDS = ['publish', 'manual'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_TTL_MS = 30 * 60_000;
/** A publish request that has been "publishing" this long without an answer is shown as unknown, never as failed. */
export const PUBLISHING_STALE_MS = 3 * 60_000;

export const ATTEMPT_KINDS = ['stage', 'publish', 'check', 'manual'] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];
export const ATTEMPT_STATUSES = ['started', 'succeeded', 'failed', 'unknown'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const CONNECTION_STATUSES = ['connected', 'needs_reconnect', 'error', 'unchecked'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  needs_reconnect: 'Needs reconnecting',
  error: 'Could not check',
  unchecked: 'Not checked yet',
};

/** How a failed platform call is classified. */
export const ERROR_KINDS = ['auth', 'forbidden_plan', 'validation', 'rate_limit', 'not_found', 'server', 'timeout', 'network', 'redirect', 'protocol', 'config'] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export const PUBLISHING_LIMITS = {
  title: 200,
  description: 500,
  series: 100,
  url: 2000,
  /** Hashnode documents a 100 KB request body, so keep the Markdown safely under it. */
  hashnodeBodyChars: 90_000,
  /** DEV.to documents no limit. This guards against absurd requests only. */
  devtoBodyChars: 300_000,
  /** Forem tag names are alphanumeric. The length cap is our reading of its model and is not documented. */
  devtoTagChars: 30,
  hashnodeTagChars: 50,
  /** Forem is reported to cap titles at 128 characters. Not documented, so only a warning. */
  devtoTitleWarn: 128,
} as const;

/** The box that must be ticked when a copy is about to go out and the page it points to is not confirmed live. */
export const CANONICAL_NOT_LIVE_BOX = 'I know the canonical page is not live yet';

export interface ChecklistOptions {
  /** `pull_request` is the personal site: nothing is public until the owner merges. `manual` records a post made by hand. */
  kind?: 'publish' | 'pull_request' | 'manual';
  /** The canonical page was checked and is not (confirmed) live. Adds one required box. */
  canonicalNotLive?: boolean;
}

/** The first checklist box is fixed; the rest are about what the payload will do. All must be ticked. */
export function approvalChecklist(platformName: string, hasCanonical: boolean, options: ChecklistOptions = {}): string[] {
  const kind = options.kind ?? 'publish';
  const boxes =
    kind === 'manual'
      ? [
          'I have read this exact payload',
          `I posted exactly this on ${platformName} myself, outside this app`,
          'The link I entered is the live post',
          'This app did not publish it and will not claim it did',
        ]
      : kind === 'pull_request'
        ? [
            'I have read this exact payload',
            `This opens a pull request on ${platformName}. Nothing goes live until I merge it`,
            hasCanonical ? 'The canonical URL points to my own site' : 'I accept that no canonical URL is set',
            'This app will not merge it and cannot undo it. Closing the pull request is done in GitHub',
          ]
        : [
            'I have read this exact payload',
            `This will be public on ${platformName} as soon as I confirm`,
            hasCanonical ? 'The canonical URL points to my own site' : 'I accept that no canonical URL is set',
            'Publishing is not undone by this app. Removing a post is done on the platform',
          ];
  if (options.canonicalNotLive && kind === 'publish') boxes.push(CANONICAL_NOT_LIVE_BOX);
  return boxes;
}

export interface LintIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  /** Extra specifics: the offending links, removed tags, and so on. */
  items?: string[];
}

export interface TagReport {
  /** Tags as they stand on the article. */
  original: string[];
  /** Tags as they will be sent. */
  sent: string[];
  /** One line per change: "C++ became c" or "kept only the first 4". */
  changes: string[];
}

/** The platform-neutral content a draft carries, after adaptation. The adapter turns it into one request body. */
export interface DraftPayload {
  title: string;
  description: string;
  tags: string[];
  canonicalUrl: string | null;
  /** A public https URL, or null. */
  coverImageUrl: string | null;
  series: string | null;
  /** The Markdown exactly as it will be sent, footer included. */
  bodyMarkdown: string;
}

/** Non-secret settings found by a connection check. */
export interface ConnectionConfig {
  publicationId?: string;
  publicationTitle?: string;
  /** Everything the Hashnode token can publish to, so the person can choose. */
  publications?: { id: string; title: string }[];
  /** Non-secret values entered for a connector (a handle, a site address, a repository). Secrets are never here. */
  fields?: Record<string, string>;
}

export interface ConnectionDTO {
  id: string;
  platform: ConnectorId;
  status: ConnectionStatus;
  /** Who the platform says the key belongs to. */
  who: string | null;
  keyLast4: string;
  /** Platform-specific, non-secret settings (the Hashnode publication). */
  config: ConnectionConfig;
  lastCheckedAt: string | null;
  lastCheckMessage: string | null;
  createdAt: string;
  /** How it was connected (see AUTH_KINDS), or null for a connection made before the connector framework. */
  authKind: string | null;
  /** The scopes the platform said it granted. */
  scopesGranted: string[];
  /** When the access token stops working, if the platform says. */
  tokenExpiresAt: string | null;
  /** A refresh token is held, so an expired access token is renewed. */
  renewable: boolean;
  /** Short code for the last failed check, or null. */
  lastErrorCode: string | null;
}

export interface AttemptDTO {
  id: string;
  kind: AttemptKind;
  status: AttemptStatus;
  httpStatus: number | null;
  errorKind: ErrorKind | null;
  message: string | null;
  remoteId: string | null;
  remoteUrl: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ApprovalDTO {
  id: string;
  status: ApprovalStatus;
  /** Short tag shown on the card and on the draft, like #3F9A12C0. */
  tag: string;
  payloadSha256: string;
  expiresAt: string;
  createdAt: string;
  invalidReason: string | null;
  requestedBy: 'owner' | 'agent';
  kind: ApprovalKind;
  /** The boxes the owner must tick, worked out by the server from the draft and the canonical check. */
  checklist: string[];
}

/** Fields of a payload an owner can edit, and so the fields divergence is reported in. */
export const PAYLOAD_FIELDS = ['title', 'description', 'tags', 'canonicalUrl', 'coverImageUrl', 'series', 'bodyMarkdown'] as const;
export type PayloadField = (typeof PAYLOAD_FIELDS)[number];

export const PAYLOAD_FIELD_LABELS: Record<PayloadField, string> = {
  title: 'Title',
  description: 'Description',
  tags: 'Tags',
  canonicalUrl: 'Canonical URL',
  coverImageUrl: 'Cover image',
  series: 'Series',
  bodyMarkdown: 'Body',
};

/** Where a draft differs: from what was generated for it (the owner's edits) and from what a rebuild would give now. */
export interface DraftDivergence {
  edited: PayloadField[];
  fromSource: PayloadField[];
}

/** What the last read-only look at the personal site's repository found. Not part of the approved payload. */
export interface RemoteInfo {
  baseSha?: string;
  fileExists?: boolean;
  fileSha?: string | null;
  branch?: string;
  path?: string;
}

export interface PlatformDraftDTO {
  id: string;
  articleId: string;
  platform: PlatformId;
  status: DraftStatus;
  stale: boolean;
  payload: DraftPayload;
  payloadSha256: string;
  /** The JSON body that will be sent to publish, as text. */
  requestPreview: string;
  tagReport: TagReport;
  lint: LintIssue[];
  account: string | null;
  sourceRevision: number;
  remoteId: string | null;
  remoteUrl: string | null;
  remotePreviewUrl: string | null;
  failureKind: ErrorKind | null;
  failureMessage: string | null;
  nextAction: string | null;
  createdAt: string;
  updatedAt: string;
  stagedAt: string | null;
  publishedAt: string | null;
  approval: ApprovalDTO | null;
  attempts: AttemptDTO[];
  /** What the adapter produced from the article when the draft was built. "Reset to generated" returns here. */
  generated: DraftPayload;
  divergence: DraftDivergence;
  /** Options that belong to the payload (the personal site's path and mapping). They are hashed with it. */
  extras: DraftExtras;
  remoteInfo: RemoteInfo | null;
  publishedVia: PublishedVia | null;
  editedAt: string | null;
  editCount: number;
  /** The last look at the canonical page, when the payload has a canonical URL. */
  canonical: CanonicalCheckDTO | null;
}

export type CanonicalState = 'live' | 'not_live' | 'unreachable' | 'blocked';

export interface CanonicalCheckDTO {
  url: string;
  state: CanonicalState;
  httpStatus: number | null;
  title: string | null;
  finalUrl: string | null;
  message: string;
  checkedAt: string;
}

export interface DestinationDTO {
  platform: PlatformId;
  info: PlatformInfo;
  connection: ConnectionDTO | null;
  draft: PlatformDraftDTO | null;
  /** The owner added this destination to the article. Only added destinations are prepared and published. */
  added: boolean;
  position: number;
  /** For the personal site: whether the settings needed to build a file are in place. */
  siteReady: boolean | null;
}

/** Whether two payload fields hold the same thing (null, empty and missing series are the same). */
function sameField(field: PayloadField, a: DraftPayload, b: DraftPayload): boolean {
  if (field === 'tags') return a.tags.length === b.tags.length && a.tags.every((tag, i) => tag === b.tags[i]);
  const x = a[field] ?? '';
  const y = b[field] ?? '';
  return x === y;
}

/** The fields where two payloads differ. */
export function diffPayload(a: DraftPayload, b: DraftPayload): PayloadField[] {
  return PAYLOAD_FIELDS.filter((field) => !sameField(field, a, b));
}

/** Approval tag for display: the first 8 hex characters of the payload hash, upper-cased. */
export function approvalTag(payloadSha256: string): string {
  return `#${payloadSha256.slice(0, 8).toUpperCase()}`;
}

/**
 * Publishing vocabulary shared by the schema, the server and the UI. No server imports.
 * Capability data lives here so the screens show exactly what each platform can and cannot do,
 * and nothing is implied beyond it. Labels and notes are user-facing copy.
 */

export const PLATFORM_IDS = ['devto', 'hashnode'] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === 'string' && (PLATFORM_IDS as readonly string[]).includes(value);
}

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

/** Statuses from which a draft can still reach a platform if the owner approves. */
export const LIVE_STATUSES: readonly DraftStatus[] = ['draft', 'staged', 'pending_approval', 'approved', 'failed'];
/** In flight or already out: nothing may send this payload again. */
export const ALREADY_OUT_STATUSES: readonly DraftStatus[] = ['publishing', 'unknown', 'published'];
/** The only statuses a stage result may move a draft out of. A late stage answer never touches any other. */
export const STAGEABLE_STATUSES: readonly DraftStatus[] = ['draft', 'staged', 'failed'];

export const APPROVAL_STATUSES = ['pending', 'used', 'denied', 'expired', 'invalidated'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

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

export interface PlatformCapabilities {
  formats: string[];
  drafts: boolean;
  /** Scheduling is not built on Day 5 whatever the platform allows. */
  scheduling: false;
  /** What the app can do with images. */
  media: string;
  statusRetrieval: boolean;
  canonicalUrl: boolean;
  series: boolean;
  tagsMax: number;
  restrictions: string[];
  cost: string;
}

export interface PlatformInfo {
  id: PlatformId;
  name: string;
  authKind: 'api_key' | 'personal_access_token';
  /** Label of the secret field, and where the person creates it. */
  secretLabel: string;
  secretHelp: string;
  capabilities: PlatformCapabilities;
  /** Whether it has been exercised against the real service. Day 5: neither has. */
  verification: { level: 'docs_and_fake' | 'docs_only'; label: string; detail: string };
}

export const PLATFORMS: Record<PlatformId, PlatformInfo> = {
  devto: {
    id: 'devto',
    name: 'DEV.to',
    authKind: 'api_key',
    secretLabel: 'DEV Community API key',
    secretHelp: 'Create one at dev.to under Settings, Extensions, “DEV Community API Keys”.',
    capabilities: {
      formats: ['Markdown (with Liquid tags)'],
      drafts: true,
      scheduling: false,
      media: 'Images must be public https links. There is no upload through the API, so local images are not sent.',
      statusRetrieval: true,
      canonicalUrl: true,
      series: true,
      tagsMax: 4,
      restrictions: [
        'At most 4 tags, lower-case letters and digits only.',
        'Your key can only change your own articles.',
        'DEV asks for disclosure of AI-assisted writing in its guidelines. Check them before you publish.',
      ],
      cost: 'Free',
    },
    verification: {
      level: 'docs_and_fake',
      label: 'Live check pending',
      detail: 'Built from the official Forem API reference and tested against a fake server. It has not been run against a real account yet.',
    },
  },
  hashnode: {
    id: 'hashnode',
    name: 'Hashnode',
    authKind: 'personal_access_token',
    secretLabel: 'Hashnode personal access token',
    secretHelp: 'Create one at Hashnode under Account settings, Developer.',
    capabilities: {
      formats: ['Markdown'],
      drafts: true,
      scheduling: false,
      media: 'Cover and images must be public https links. Image upload exists in the API but is not used yet.',
      statusRetrieval: true,
      canonicalUrl: true,
      series: false,
      tagsMax: 15,
      restrictions: [
        'The API needs a Pro plan on the publication you publish to. Without it every write is refused.',
        'Request bodies are limited to 100 KB, which caps article length.',
        'Contributors on a team publication cannot publish directly.',
      ],
      cost: 'Pro plan: $5 per month or $50 per year per publication (as listed by Hashnode).',
    },
    verification: {
      level: 'docs_only',
      label: 'Live-unverified',
      detail: 'Built from the official schema and agent skill and tested against fake responses only. It has never run against a real account; expect to adjust it on first use.',
    },
  },
};

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

/** The first checklist box is fixed; the rest are about what the payload will do. All must be ticked. */
export function approvalChecklist(platformName: string, hasCanonical: boolean): string[] {
  return [
    'I have read this exact payload',
    `This will be public on ${platformName} as soon as I confirm`,
    hasCanonical ? 'The canonical URL points to my own site' : 'I accept that no canonical URL is set',
    'Publishing is not undone by this app. Removing a post is done on the platform',
  ];
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
}

export interface ConnectionDTO {
  id: string;
  platform: PlatformId;
  status: ConnectionStatus;
  /** Who the platform says the key belongs to. */
  who: string | null;
  keyLast4: string;
  /** Platform-specific, non-secret settings (the Hashnode publication). */
  config: ConnectionConfig;
  lastCheckedAt: string | null;
  lastCheckMessage: string | null;
  createdAt: string;
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
}

export interface DestinationDTO {
  platform: PlatformId;
  info: PlatformInfo;
  connection: ConnectionDTO | null;
  draft: PlatformDraftDTO | null;
}

/** Approval tag for display: the first 8 hex characters of the payload hash, upper-cased. */
export function approvalTag(payloadSha256: string): string {
  return `#${payloadSha256.slice(0, 8).toUpperCase()}`;
}

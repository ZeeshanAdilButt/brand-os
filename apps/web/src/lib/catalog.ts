/**
 * The destination catalog: every platform on the roadmap, with what the app can and cannot do for it today.
 * One registry, no server imports, so the composer, Platforms > Integrations, the previews, the limits and the
 * manual-posting kit all read the same facts. Nothing here implies a capability that is not built: a platform
 * without an adapter says why, and says when it is planned. Figures come from docs/research/01-06 and
 * INTEGRATIONS.md; anything not confirmed from a primary source is listed under `unverified`.
 */

export const PLATFORM_IDS = [
  'devto',
  'hashnode',
  'site',
  'medium',
  'substack',
  'linkedin',
  'x',
  'bluesky',
  'threads',
  'mastodon',
  'reddit',
  'hackernews',
  'youtube',
] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

/** What a destination is, which decides how it is adapted and previewed. */
export type CatalogKind = 'long_form' | 'short_form' | 'link_submission' | 'video';

export const KIND_LABELS: Record<CatalogKind, string> = {
  long_form: 'Long-form article',
  short_form: 'Short post',
  link_submission: 'Link submission',
  video: 'Video',
};

/**
 * How the owner connects: paste a key with a guided wizard, authorize with OAuth (the framework for that is the next
 * task), or nothing at all because the platform has no API (the owner posts by hand).
 */
export type ConnectMethod = 'api_key_guided' | 'oauth' | 'manual_only';

/**
 * What the app does for a platform today. `adapter`: it can stage, request approval for and publish through a built
 * adapter (once connected). `preview_only`: the draft and preview work; there is nothing to send to. `manual_only`:
 * the platform has no usable API, so the app prepares everything and the owner posts it. `coming_later`: an adapter
 * is planned on the roadmap; until then the owner can still preview and post by hand.
 */
export type CatalogState = 'adapter' | 'preview_only' | 'manual_only' | 'coming_later';

/** The state a card shows: the catalog state combined with whether the connection works. */
export type PublishingState = 'available' | 'connect_required' | 'preview_only' | 'manual_only' | 'coming_later';

export type IconName = 'file-text' | 'newspaper' | 'globe' | 'share' | 'message' | 'link' | 'video' | 'mail' | 'at-sign' | 'users';

/** How a post's length is counted on that platform. */
export type CountUnit = 'characters' | 'graphemes' | 'x_weighted';

export interface PlatformLimits {
  /** Longest title, or null when the platform has no title. */
  title: number | null;
  /** Longest body in `unit`, or null when no limit is known. */
  body: number | null;
  unit: CountUnit;
  /** Characters shown before a feed cuts the text with "see more", or null. */
  fold: number | null;
  tagsMax: number | null;
  imagesMax: number | null;
  /** Posts in a thread are split at `body`. */
  thread: boolean;
}

export type SubmitLinkKind = 'hackernews' | 'reddit' | 'x' | 'linkedin' | 'bluesky' | 'threads' | 'mastodon' | 'github';

export interface ConnectGuide {
  /** Label of the link that opens the exact settings page. */
  openLabel: string;
  openUrl: string;
  /** Two or three plain steps, shown beside the paste field. */
  steps: string[];
  /** For OAuth platforms: what must be registered once. */
  oauth?: { register: string[]; scopes: string[]; redirectPath: string; note: string };
}

export interface ManualGuide {
  /** The compose or import page of the platform. */
  openUrl: string;
  openLabel: string;
  /** A pre-filled link, where the platform has one. */
  submitLink: SubmitLinkKind | null;
  steps: string[];
  /** Hosts a recorded link must be on. `*.x` matches any subdomain. */
  hosts: string[];
}

export interface PlatformCapabilities {
  formats: string[];
  drafts: boolean;
  /** Scheduling is not built yet whatever the platform allows. */
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
  /** Two or three letters shown in the platform tile. Brand logos are not used. */
  monogram: string;
  icon: IconName;
  kind: CatalogKind;
  connectMethod: ConnectMethod;
  state: CatalogState;
  /** Where on the roadmap it arrives, for `coming_later`. */
  roadmap: string | null;
  /** One line: why the card is not actionable, or what it does instead. */
  reason: string;
  authKind: 'api_key' | 'personal_access_token' | 'oauth' | 'app_password' | 'none';
  /** Label of the secret field, and where the person creates it. */
  secretLabel: string;
  secretHelp: string;
  connect: ConnectGuide;
  manual: ManualGuide;
  capabilities: PlatformCapabilities;
  limits: PlatformLimits;
  /** Facts from the research notes that could not be confirmed from a primary source. */
  unverified: string[];
  /** Whether it has been exercised against the real service. */
  verification: { level: 'docs_and_fake' | 'docs_only' | 'research_only' | 'not_built'; label: string; detail: string };
}

const OAUTH_NOTE = 'OAuth connections are coming next. Until then the Connect button stays off, and you can still preview the post and post it by hand.';
const NOT_BUILT = { level: 'not_built', label: 'Not built yet', detail: 'No adapter exists yet, so nothing is sent to this platform. Preview and manual posting work.' } as const;

const none = (cost: string, restrictions: string[], media: string): PlatformCapabilities => ({
  formats: [],
  drafts: false,
  scheduling: false,
  media,
  statusRetrieval: false,
  canonicalUrl: false,
  series: false,
  tagsMax: 0,
  restrictions,
  cost,
});

export const PLATFORMS: Record<PlatformId, PlatformInfo> = {
  devto: {
    id: 'devto',
    name: 'DEV.to',
    monogram: 'DEV',
    icon: 'file-text',
    kind: 'long_form',
    connectMethod: 'api_key_guided',
    state: 'adapter',
    roadmap: null,
    reason: 'Private drafts and approved publishing through the Forem API.',
    authKind: 'api_key',
    secretLabel: 'DEV Community API key',
    secretHelp: 'Create one at dev.to under Settings, Extensions, “DEV Community API Keys”.',
    connect: {
      openLabel: 'Open DEV.to settings',
      openUrl: 'https://dev.to/settings/extensions',
      steps: ['Open the page below and scroll to “DEV Community API Keys”.', 'Type a name such as “Brand OS” and choose Generate API Key.', 'Copy the key and paste it here. It is shown once.'],
    },
    manual: {
      openUrl: 'https://dev.to/new',
      openLabel: 'Open the DEV.to editor',
      submitLink: null,
      steps: ['Paste the title, then the Markdown body, into the editor.', 'Set the tags and the canonical URL under the post options.', 'Publish, then paste the link of the live post here.'],
      hosts: ['dev.to'],
    },
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
    limits: { title: 128, body: 300_000, unit: 'characters', fold: null, tagsMax: 4, imagesMax: null, thread: false },
    unverified: ['The 128-character title cap is reported, not documented.'],
    verification: {
      level: 'docs_and_fake',
      label: 'Live check pending',
      detail: 'Built from the official Forem API reference and tested against a fake server. It has not been run against a real account yet.',
    },
  },
  hashnode: {
    id: 'hashnode',
    name: 'Hashnode',
    monogram: 'H',
    icon: 'newspaper',
    kind: 'long_form',
    connectMethod: 'api_key_guided',
    state: 'adapter',
    roadmap: null,
    reason: 'Private drafts and approved publishing through the GraphQL API (needs a Pro publication).',
    authKind: 'personal_access_token',
    secretLabel: 'Hashnode personal access token',
    secretHelp: 'Create one at Hashnode under Account settings, Developer.',
    connect: {
      openLabel: 'Open Hashnode developer settings',
      openUrl: 'https://hashnode.com/settings/developer',
      steps: ['Open the page below and choose “Generate new token”.', 'Name it “Brand OS” and copy the token.', 'Paste it here. The app finds your publications with a read-only request.'],
    },
    manual: {
      openUrl: 'https://hashnode.com/',
      openLabel: 'Open Hashnode',
      submitLink: null,
      steps: ['Start a new article in your publication and paste the title and Markdown body.', 'Set the tags and the “originally published at” URL in the article settings.', 'Publish, then paste the link of the live post here.'],
      hosts: ['hashnode.dev', '*.hashnode.dev', 'hashnode.com', '*.hashnode.com'],
    },
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
    limits: { title: 200, body: 90_000, unit: 'characters', fold: null, tagsMax: 15, imagesMax: null, thread: false },
    unverified: ['Custom publication domains are not known to the link check: use Hashnode’s own address when recording a post by hand.'],
    verification: {
      level: 'docs_only',
      label: 'Live-unverified',
      detail: 'Built from the official schema and agent skill and tested against fake responses only. It has never run against a real account; expect to adjust it on first use.',
    },
  },
  site: {
    id: 'site',
    name: 'Personal site',
    monogram: 'You',
    icon: 'globe',
    kind: 'long_form',
    connectMethod: 'api_key_guided',
    state: 'adapter',
    roadmap: null,
    reason: 'Markdown export, or a reviewable pull request on your site’s repository. Never merges.',
    authKind: 'personal_access_token',
    secretLabel: 'GitHub fine-grained token',
    secretHelp: 'Create one at GitHub under Settings, Developer settings, Fine-grained tokens. Limit it to the one repository that holds your site, with Contents: read and write and Pull requests: read and write.',
    connect: {
      openLabel: 'Open GitHub token settings',
      openUrl: 'https://github.com/settings/personal-access-tokens/new',
      steps: [
        'Open the page below. Under Repository access choose “Only select repositories” and pick your site’s repository.',
        'Under Repository permissions set Contents to Read and write, and Pull requests to Read and write. Leave everything else off.',
        'Generate the token, copy it and paste it here. Save the repository, branch and path settings first.',
      ],
    },
    manual: {
      openUrl: 'https://github.com/',
      openLabel: 'Open GitHub',
      submitLink: 'github',
      steps: ['Add the file to your site in the way you normally do, using the copied Markdown with its front matter.', 'Publish your site as usual.', 'Paste the address of the live post here.'],
      hosts: [],
    },
    capabilities: {
      formats: ['Markdown with front matter (a preset you can edit)'],
      drafts: false,
      scheduling: false,
      media: 'Images are not uploaded. Use links that already work in your site, a path that exists in the repository, or a public https address.',
      statusRetrieval: true,
      canonicalUrl: true,
      series: true,
      tagsMax: 50,
      restrictions: [
        'Markdown export needs no account and makes no network request.',
        'The GitHub route only ever creates a new branch, commits one file and opens a pull request. It never pushes to the base branch and never merges.',
        'It refuses to replace a file that already exists unless you marked the draft “update existing” and the file is unchanged since you looked.',
        'Your site goes live only when you merge the pull request in GitHub.',
      ],
      cost: 'Free',
    },
    limits: { title: null, body: null, unit: 'characters', fold: null, tagsMax: 50, imagesMax: null, thread: false },
    unverified: [],
    verification: {
      level: 'docs_and_fake',
      label: 'Live check pending',
      detail: 'Built from the official GitHub REST reference and tested against a fake server. It has not been run against a real repository yet.',
    },
  },
  medium: {
    id: 'medium',
    name: 'Medium',
    monogram: 'M',
    icon: 'newspaper',
    kind: 'long_form',
    connectMethod: 'manual_only',
    state: 'manual_only',
    roadmap: null,
    reason: 'Medium has no API for new apps: use Copy for manual posting, or its Import a story tool.',
    authKind: 'none',
    secretLabel: '',
    secretHelp: '',
    connect: { openLabel: 'Open Medium', openUrl: 'https://medium.com/', steps: ['Medium stopped issuing integration tokens, so there is nothing to connect.', 'Use “Copy for manual posting”, or Medium’s own Import a story tool with your canonical URL.'] },
    manual: {
      openUrl: 'https://medium.com/p/import',
      openLabel: 'Open Medium’s import tool',
      submitLink: null,
      steps: [
        'Best: paste your canonical URL into Import a story. Medium sets the canonical link for you.',
        'Or paste the copied text into a new story, then set the canonical link under More settings, Advanced settings.',
        'Medium needs a disclosure line when AI helped write the text. Publish, then paste the link here.',
      ],
      hosts: ['medium.com', '*.medium.com'],
    },
    capabilities: { ...none('Free to publish. Membership ($5 a month) is only needed for the Partner Program.', ['Tables and custom components do not import: use images for them.', 'Medium’s rules ban posting by scripts or browser automation, so this app never drives the editor.', 'Only the first 5 topics are used.'], 'Images are inserted in Medium’s editor.'), formats: ['Rich text, pasted or imported'], canonicalUrl: true, tagsMax: 5 },
    limits: { title: 100, body: null, unit: 'characters', fold: null, tagsMax: 5, imagesMax: null, thread: false },
    unverified: ['Whether an old integration token still publishes is UNVERIFIED.', 'Import fidelity for tables and SVG is UNVERIFIED.'],
    verification: { level: 'research_only', label: 'Manual only', detail: 'From Medium’s help pages. The app prepares the post; you post it.' },
  },
  substack: {
    id: 'substack',
    name: 'Substack',
    monogram: 'S',
    icon: 'mail',
    kind: 'long_form',
    connectMethod: 'manual_only',
    state: 'manual_only',
    roadmap: null,
    reason: 'Substack has no publishing API: use Copy for manual posting.',
    authKind: 'none',
    secretLabel: '',
    secretHelp: '',
    connect: { openLabel: 'Open Substack', openUrl: 'https://substack.com/', steps: ['Substack has no public publishing API, so there is nothing to connect.', 'Use “Copy for manual posting” and paste into a new post.'] },
    manual: {
      openUrl: 'https://substack.com/',
      openLabel: 'Open Substack',
      submitLink: null,
      steps: ['Start a new post in your publication and paste the title, subtitle and body.', 'Substack has no canonical field, so keep the “Originally published at” line at the end.', 'Publish or send, then paste the link of the live post here.'],
      hosts: ['substack.com', '*.substack.com'],
    },
    capabilities: { ...none('Free. Substack keeps 10% of paid subscriptions if you charge.', ['No canonical URL field: the post canonicalizes to itself, so publish on your site first and let it be indexed.', 'Unofficial drafting libraries break its terms and are not used.'], 'Images are inserted in Substack’s editor.'), formats: ['Rich text, pasted'] },
    limits: { title: null, body: null, unit: 'characters', fold: null, tagsMax: null, imagesMax: null, thread: false },
    unverified: ['Title and subtitle length limits are not documented here.', 'Table support in the editor is UNVERIFIED.', 'A canonical setting in the advanced options is reported by one source and denied by others.'],
    verification: { level: 'research_only', label: 'Manual only', detail: 'From Substack’s help pages and terms. The app prepares the post; you post it.' },
  },
  linkedin: {
    id: 'linkedin',
    name: 'LinkedIn',
    monogram: 'in',
    icon: 'share',
    kind: 'short_form',
    connectMethod: 'oauth',
    state: 'coming_later',
    roadmap: 'Phase 2',
    reason: 'Posting arrives in Phase 2. Preview it now and post it by hand.',
    authKind: 'oauth',
    secretLabel: '',
    secretHelp: '',
    connect: {
      openLabel: 'Open the LinkedIn developer portal',
      openUrl: 'https://www.linkedin.com/developers/apps',
      steps: ['Create an app and associate it with a LinkedIn Page you manage.', 'Add the products “Share on LinkedIn” and “Sign In with LinkedIn using OpenID Connect”.', 'Add the redirect URL below under Auth, then paste the client ID and secret here once the connect framework lands.'],
      oauth: {
        register: ['A LinkedIn developer app linked to a Page you manage', 'Products: Share on LinkedIn; Sign In with LinkedIn using OpenID Connect'],
        scopes: ['openid', 'profile', 'w_member_social'],
        redirectPath: '/api/connect/linkedin/callback',
        note: 'Access tokens last 60 days and cannot be refreshed by a self-serve app, so you reconnect with one click about every two months.',
      },
    },
    manual: {
      openUrl: 'https://www.linkedin.com/feed/',
      openLabel: 'Open LinkedIn',
      submitLink: 'linkedin',
      steps: ['Start a post and paste the copied text. The link card appears from the link.', 'Check the first lines: only the first few show before “see more”.', 'Post, then paste the link of the post here.'],
      hosts: ['linkedin.com', '*.linkedin.com', 'lnkd.in'],
    },
    capabilities: { ...none('Free API.', ['150 API requests per member per day.', 'Native LinkedIn articles and newsletters have no API.', 'Tokens last 60 days and need a reconnect.'], 'One link card, up to 9 images, or one video or document.'), formats: ['Plain text with a link card'], tagsMax: 5 },
    limits: { title: null, body: 3000, unit: 'characters', fold: 210, tagsMax: 5, imagesMax: 9, thread: false },
    unverified: ['The 3,000-character limit is widely reported but was not confirmed in the docs read.', 'The “see more” cut-off is about 210 characters on desktop and shorter on phones: UNVERIFIED and it varies.'],
    verification: NOT_BUILT,
  },
  x: {
    id: 'x',
    name: 'X',
    monogram: 'X',
    icon: 'message',
    kind: 'short_form',
    connectMethod: 'oauth',
    state: 'coming_later',
    roadmap: 'Phase 2',
    reason: 'Posting arrives in Phase 2 and costs money per post. Preview it now; the intent link posts by hand for free.',
    authKind: 'oauth',
    secretLabel: '',
    secretHelp: '',
    connect: {
      openLabel: 'Open the X developer console',
      openUrl: 'https://console.x.com/',
      steps: ['Create a project and an app, enable OAuth 2.0 and set permissions to Read and write.', 'Add the redirect URL below as a callback.', 'Add a payment card, buy a small credit and set a spending limit. Leave auto-recharge off.'],
      oauth: {
        register: ['An X developer app with OAuth 2.0 enabled (a confidential “Web App” client)', 'Billing: prepaid credits with a spending limit'],
        scopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
        redirectPath: '/api/connect/x/callback',
        note: 'Access tokens last two hours; the refresh token renews them.',
      },
    },
    manual: {
      openUrl: 'https://x.com/compose/post',
      openLabel: 'Open X',
      submitLink: 'x',
      steps: ['Open the pre-filled post, or paste the copied text. Threads are posted one post at a time.', 'Keep the link in one post only: a post with a link costs far more through the API.', 'Post, then paste the link of the first post here.'],
      hosts: ['x.com', 'twitter.com', '*.x.com', 'mobile.twitter.com'],
    },
    capabilities: {
      ...none('Pay per use: $0.015 per post and $0.20 per post that contains a link (verified on the X pricing page). No free tier for new developers.', ['100 posts per 15 minutes per user.', 'Posts over 280 characters need X Premium.', 'A retry is a second charge, so the app never retries a publish.'], 'Up to 4 images or one video per post.'),
      formats: ['Plain text posts, threads'],
      tagsMax: 2,
    },
    limits: { title: null, body: 280, unit: 'x_weighted', fold: null, tagsMax: 2, imagesMax: 4, thread: true },
    unverified: ['Whether v2 media upload accepts OAuth 1.0a is UNVERIFIED.', 'Media upload cost and the minimum credit purchase are UNVERIFIED.', 'The Premium requirement for long posts is third-party only.'],
    verification: NOT_BUILT,
  },
  bluesky: {
    id: 'bluesky',
    name: 'Bluesky',
    monogram: 'Bsky',
    icon: 'at-sign',
    kind: 'short_form',
    connectMethod: 'api_key_guided',
    state: 'coming_later',
    roadmap: 'Phase 2',
    reason: 'Posting arrives in Phase 2. Preview it now and post it by hand.',
    authKind: 'app_password',
    secretLabel: 'Bluesky app password',
    secretHelp: 'Create one in the Bluesky app under Settings, Privacy and security, App passwords. Never use your main password.',
    connect: {
      openLabel: 'Open Bluesky app passwords',
      openUrl: 'https://bsky.app/settings/app-passwords',
      steps: ['Open the page below and choose “Add App Password”.', 'Name it “Brand OS” and copy the password it shows once.', 'Paste it here with your handle once the Bluesky adapter lands.'],
    },
    manual: {
      openUrl: 'https://bsky.app/',
      openLabel: 'Open Bluesky',
      submitLink: 'bluesky',
      steps: ['Open the pre-filled post, or paste the copied text.', 'Links in a post count against the 300 graphemes.', 'Post, then paste the link of the post here.'],
      hosts: ['bsky.app'],
    },
    capabilities: { ...none('Free.', ['5,000 write points per hour; a post costs 3.', 'Links need facets and a link card needs an uploaded thumbnail.'], 'Up to 4 images, or one video.'), formats: ['Plain text posts, threads'], tagsMax: 3 },
    limits: { title: null, body: 300, unit: 'graphemes', fold: null, tagsMax: 3, imagesMax: 4, thread: true },
    unverified: ['The 300-grapheme limit is well known but was not confirmed on a primary source in this research.', 'Whether app passwords are still offered in late 2026 is UNVERIFIED.'],
    verification: NOT_BUILT,
  },
  threads: {
    id: 'threads',
    name: 'Threads',
    monogram: 'Th',
    icon: 'at-sign',
    kind: 'short_form',
    connectMethod: 'oauth',
    state: 'coming_later',
    roadmap: 'Phase 2',
    reason: 'Posting arrives in Phase 2. Preview it now and post it by hand.',
    authKind: 'oauth',
    secretLabel: '',
    secretHelp: '',
    connect: {
      openLabel: 'Open Meta for Developers',
      openUrl: 'https://developers.facebook.com/apps/',
      steps: ['Create an app with the “Access the Threads API” use case.', 'Add your Threads account as a Threads tester and accept the invite in Threads.', 'Add the redirect URL below (Meta usually needs https) and connect once the framework lands.'],
      oauth: {
        register: ['A Meta app with the Threads use case', 'Your own Threads account added as a tester (no App Review for your own use)'],
        scopes: ['threads_basic', 'threads_content_publish'],
        redirectPath: '/api/connect/threads/callback',
        note: 'Long-lived tokens last 60 days and can be refreshed. Meta often rejects plain-http redirects: UNVERIFIED for Threads.',
      },
    },
    manual: {
      openUrl: 'https://www.threads.com/',
      openLabel: 'Open Threads',
      submitLink: 'threads',
      steps: ['Open the pre-filled post, or paste the copied text.', 'Threads takes one topic tag; the first hashtag becomes it.', 'Post, then paste the link of the post here.'],
      hosts: ['threads.net', 'threads.com', '*.threads.net', '*.threads.com'],
    },
    capabilities: { ...none('Free.', ['250 API posts per 24 hours.', 'Images and video must be at a public URL.'], 'Up to 20 items in a carousel.'), formats: ['Plain text posts'], tagsMax: 1 },
    limits: { title: null, body: 500, unit: 'graphemes', fold: null, tagsMax: 1, imagesMax: 20, thread: true },
    unverified: ['The intent link on threads.com is UNVERIFIED.', 'Whether Meta rejects plain-http localhost redirects for Threads is UNVERIFIED.'],
    verification: NOT_BUILT,
  },
  mastodon: {
    id: 'mastodon',
    name: 'Mastodon',
    monogram: 'Mast',
    icon: 'users',
    kind: 'short_form',
    connectMethod: 'oauth',
    state: 'coming_later',
    roadmap: 'Not scheduled yet',
    reason: 'No roadmap day yet. Preview it now and post it by hand on your instance.',
    authKind: 'oauth',
    secretLabel: '',
    secretHelp: '',
    connect: {
      openLabel: 'Open your instance’s developer settings',
      openUrl: 'https://mastodon.social/settings/applications',
      steps: ['On your instance open Preferences, Development, New application.', 'Give it the scopes below and copy the access token.', 'Add your instance address here once the connect framework lands.'],
      oauth: {
        register: ['An application on your own Mastodon instance'],
        scopes: ['write:statuses', 'write:media', 'read:accounts'],
        redirectPath: '/api/connect/mastodon/callback',
        note: 'A personal access token from your instance also works and does not expire. Character and media limits are set by the instance.',
      },
    },
    manual: {
      openUrl: 'https://joinmastodon.org/servers',
      openLabel: 'Open your instance',
      submitLink: 'mastodon',
      steps: ['Set your instance address in the destination options so the share link opens there.', 'Paste the copied text if you prefer to compose by hand.', 'Post, then paste the link of the toot here.'],
      hosts: ['*'],
    },
    capabilities: { ...none('Free.', ['Limits are per instance: 500 characters by default.', '300 requests per 5 minutes; 30 media uploads per 30 minutes.'], 'Up to 4 images.'), formats: ['Plain text posts'], tagsMax: 4 },
    limits: { title: null, body: 500, unit: 'characters', fold: null, tagsMax: 4, imagesMax: 4, thread: true },
    unverified: ['The limit is per instance; 500 is the stock default. Read it from your instance.'],
    verification: NOT_BUILT,
  },
  reddit: {
    id: 'reddit',
    name: 'Reddit',
    monogram: 'r/',
    icon: 'message',
    kind: 'link_submission',
    connectMethod: 'manual_only',
    state: 'manual_only',
    roadmap: 'Phase 2',
    reason: 'Reddit gates API access and bans automated link drops: this opens a pre-filled submit link for you to review.',
    authKind: 'none',
    secretLabel: '',
    secretHelp: '',
    connect: { openLabel: 'Open Reddit', openUrl: 'https://www.reddit.com/', steps: ['New API tokens need Reddit’s approval and personal scripts are often refused, so the app does not automate Reddit.', 'It prepares a title and body and opens the submit page for you.'] },
    manual: {
      openUrl: 'https://www.reddit.com/submit',
      openLabel: 'Open Reddit’s submit page',
      submitLink: 'reddit',
      steps: ['Set the subreddit in the destination options, and read its rules first: many ban self-promotion.', 'Open the pre-filled submit page and check the title and body.', 'Submit it yourself, then paste the link of the post here.'],
      hosts: ['reddit.com', '*.reddit.com', 'redd.it'],
    },
    capabilities: { ...none('Free tier exists but access needs approval.', ['Subreddit self-promotion rules vary; automated link drops risk a ban.', 'Discussion-first posts do better than a bare link.'], 'Images are attached on the submit page.'), formats: ['Markdown self-post or a link'] },
    limits: { title: 300, body: 40_000, unit: 'characters', fold: null, tagsMax: null, imagesMax: 20, thread: false },
    unverified: ['Reddit’s commercial API pricing in 2026 is UNVERIFIED.', 'The body limit is the commonly reported figure.'],
    verification: { level: 'research_only', label: 'Manual only', detail: 'From the research notes. The app prepares a pre-filled submit link; you submit it.' },
  },
  hackernews: {
    id: 'hackernews',
    name: 'Hacker News',
    monogram: 'HN',
    icon: 'link',
    kind: 'link_submission',
    connectMethod: 'manual_only',
    state: 'manual_only',
    roadmap: 'Phase 2',
    reason: 'Hacker News has no submission API: this opens a pre-filled submit link for you to review.',
    authKind: 'none',
    secretLabel: '',
    secretHelp: '',
    connect: { openLabel: 'Open Hacker News', openUrl: 'https://news.ycombinator.com/', steps: ['Hacker News has no write API, so there is nothing to connect.', 'The app opens its submit page with the title and link filled in.'] },
    manual: {
      openUrl: 'https://news.ycombinator.com/submit',
      openLabel: 'Open the submit page',
      submitLink: 'hackernews',
      steps: ['Open the pre-filled submit page. Use the title as written: do not add promotion.', 'Submit it yourself while signed in.', 'Open your submission and paste its link here (it contains item?id=).'],
      hosts: ['news.ycombinator.com'],
    },
    capabilities: { ...none('Free.', ['Titles are 80 characters at most.', 'A submission takes a link or text, not both.', 'No voting rings: do not ask others to upvote.'], 'No images.'), formats: ['A title and a link'] },
    limits: { title: 80, body: null, unit: 'characters', fold: null, tagsMax: null, imagesMax: 0, thread: false },
    unverified: [],
    verification: { level: 'research_only', label: 'Manual only', detail: 'No API exists. The app prepares a pre-filled submit link; you submit it.' },
  },
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    monogram: 'YT',
    icon: 'video',
    kind: 'video',
    connectMethod: 'oauth',
    state: 'preview_only',
    roadmap: 'Phase 5',
    reason: 'There is no video yet, so this shows the metadata only. Uploads arrive with the video pipeline (Phase 5).',
    authKind: 'oauth',
    secretLabel: '',
    secretHelp: '',
    connect: {
      openLabel: 'Open Google Cloud console',
      openUrl: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
      steps: ['Create a project and enable the YouTube Data API v3.', 'Configure the OAuth consent screen and create a “Desktop app” client.', 'Set the consent screen to “In production”: tokens from a project in Testing expire after 7 days.'],
      oauth: {
        register: ['A Google Cloud project with YouTube Data API v3 enabled', 'An OAuth consent screen set to In production, and a Desktop-app client'],
        scopes: ['https://www.googleapis.com/auth/youtube.upload'],
        redirectPath: '/api/connect/youtube/callback',
        note: 'Uploads from an unverified app may default to private until the project is audited: UNVERIFIED for personal use.',
      },
    },
    manual: {
      openUrl: 'https://studio.youtube.com/',
      openLabel: 'Open YouTube Studio',
      submitLink: null,
      steps: ['Upload the video in Studio and paste the copied title and description.', 'Set the thumbnail and check the chapters appear.', 'Publish, then paste the link of the video here.'],
      hosts: ['youtube.com', '*.youtube.com', 'youtu.be'],
    },
    capabilities: { ...none('Free API; uploads use a daily quota.', ['About 100 uploads a day through the API.', 'Chapters need a first timestamp at 0:00, at least three, and each at least 10 seconds long.'], 'The video and thumbnail are uploaded in Studio.'), formats: ['Video with a title, description and chapters'], tagsMax: 15 },
    limits: { title: 100, body: 5000, unit: 'characters', fold: 150, tagsMax: 15, imagesMax: 1, thread: false },
    unverified: ['The quota and the private-by-default behaviour of unverified apps are UNVERIFIED for personal use.', 'The 15-tag figure is a guideline: YouTube limits the tags to 500 characters in total.'],
    verification: NOT_BUILT,
  },
};

export function platformInfo(id: PlatformId): PlatformInfo {
  return PLATFORMS[id];
}

export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === 'string' && (PLATFORM_IDS as readonly string[]).includes(value);
}

/** The app can stage, ask for approval and publish to this platform (once connected). Everything else is preview and hand posting. */
export function isPublishable(platform: PlatformId): boolean {
  return PLATFORMS[platform].state === 'adapter';
}

/** The platforms the app can send to through an adapter. */
export const PUBLISHABLE_IDS: readonly PlatformId[] = PLATFORM_IDS.filter((id) => PLATFORMS[id].state === 'adapter');

/** What a card shows: the static state, and for an adapter whether the connection works. */
export function publishingState(platform: PlatformId, connected: boolean): PublishingState {
  const info = PLATFORMS[platform];
  if (info.state === 'adapter') return connected ? 'available' : 'connect_required';
  return info.state;
}

export const PUBLISHING_STATE_LABELS: Record<PublishingState, string> = {
  available: 'Available',
  connect_required: 'Connect required',
  preview_only: 'Preview only',
  manual_only: 'Manual only',
  coming_later: 'Coming later',
};

/** The one-line reason under a card's name, specific to its state. */
export function stateReason(platform: PlatformId, state: PublishingState): string {
  const info = PLATFORMS[platform];
  if (state === 'connect_required') return `Connect ${info.name} to stage and publish. Preview and manual posting work without it.`;
  if (state === 'available') return info.reason;
  if (state === 'coming_later' && info.roadmap) return info.reason;
  return info.reason;
}

/** Recommended order in the composer: your own site first so the canonical page exists, then long-form copies, then the rest. */
export const RECOMMENDED_ORDER: readonly PlatformId[] = ['site', 'devto', 'hashnode', 'medium', 'substack', 'linkedin', 'x', 'bluesky', 'threads', 'mastodon', 'reddit', 'hackernews', 'youtube'];

/** Platforms that copy an article from the owner's own site. They get the canonical-page check. */
export function isSyndication(platform: PlatformId): boolean {
  return platform !== 'site';
}

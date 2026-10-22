import { PLATFORMS, PLATFORM_IDS, publishingState, type PlatformId, type PublishingState } from './catalog';

/**
 * The platform directory: every place content can go or be submitted, across all areas of the roadmap, with what
 * the app can do for each today. The first thirteen are the composer's destinations (drafts, previews, manual
 * posting) and come from the catalog; the rest are listed so everything shows up, and are visibly disabled until
 * their roadmap phase. Nothing here is enabled that is not built. Facts that were not checked against an official
 * page in this project are listed under `unverified`, never stated as certain.
 */

export const AREAS = ['blogs', 'social', 'communities', 'video', 'conferences', 'editorial', 'launches', 'aggregators'] as const;
export type Area = (typeof AREAS)[number];

export const AREA_LABELS: Record<Area, string> = {
  blogs: 'Blogs and articles',
  social: 'Social',
  communities: 'Communities',
  video: 'Video',
  conferences: 'Conferences and talks',
  editorial: 'Editorial publications',
  launches: 'Software and product launches',
  aggregators: 'Aggregators',
};

export const AREA_BLURBS: Record<Area, string> = {
  blogs: 'Your own site and the places that republish a full article.',
  social: 'Short posts that point readers to the article.',
  communities: 'Forums and chats where a link is discussed. Each has its own rules.',
  video: 'Long videos and short clips (metadata first, uploads come with the video pipeline).',
  conferences: 'Calls for papers and event sites. Directory only for now.',
  editorial: 'Publications with editors, where you pitch rather than post.',
  launches: 'Release notes, product launches and package registries.',
  aggregators: 'Services that post to many channels for you.',
};

/** How content reaches the platform. `browser_assisted`: a console step the owner does with their own browser (or their own Claude with browser access). */
export type ContentMethod = 'api' | 'oauth' | 'api_key' | 'browser_assisted' | 'manual_only';

export const METHOD_LABELS: Record<ContentMethod, string> = {
  api: 'API',
  oauth: 'OAuth',
  api_key: 'API key',
  browser_assisted: 'Assisted setup',
  manual_only: 'Manual only',
};

export const METHOD_HINTS: Record<ContentMethod, string> = {
  api: 'Public API, no per-user key.',
  oauth: 'You register an app once and authorize it.',
  api_key: 'You create a key or token and paste it once.',
  browser_assisted: 'You create the app or key in the platform’s console. A step list and a prompt for your own Claude are provided.',
  manual_only: 'No API for this. The app prepares everything and you post it yourself.',
};

/** What a card says about the platform today. */
export type DirectoryStatus = 'available_now' | 'needs_connection' | 'preview_only' | 'manual_only' | 'planned';

export const STATUS_LABELS: Record<DirectoryStatus, string> = {
  available_now: 'Available now',
  needs_connection: 'Needs connection',
  preview_only: 'Preview only',
  manual_only: 'Manual only',
  planned: 'Planned',
};

export interface AssistedSetup {
  /** The platform’s console or settings page, where the key or app is made. */
  consoleUrl: string;
  consoleLabel: string;
  steps: string[];
}

export interface DirectoryEntry {
  id: string;
  name: string;
  area: Area;
  /** What it is, in a sentence. */
  summary: string;
  /** The official site or documentation. */
  url: string;
  method: ContentMethod;
  /** What the app plans to support, in words. */
  plan: string;
  /** Where on the roadmap, or null when it is built or not scheduled. */
  roadmap: string | null;
  restrictions: string[];
  cost: string;
  /** Statements that were not confirmed from a primary source in this project. */
  unverified: string[];
  /** The composer destination for this entry, when drafts and previews exist for it. */
  composer: PlatformId | null;
  /** The adapter exists: it can be connected and publish through the app. */
  adapter: boolean;
  /** Setup text for a key or secret. */
  secretLabel: string;
  secretHelp: string;
  assisted: AssistedSetup | null;
  oauth: { scopes: string[]; redirectPath: string; register: string[]; note: string } | null;
  /** Directory only: no content or CFP data is read for it. */
  directoryOnly: boolean;
}

const PHASE2 = 'Phase 2, Days 8 to 12';
const PHASE3 = 'Phase 3, Days 13 to 16';
const PHASE4 = 'Phase 4, Days 17 to 20';
const PHASE5 = 'Phase 5, Days 21 to 24';
const PHASE7 = 'Phase 7, after Phase 6';

interface Extra {
  id: string;
  name: string;
  area: Area;
  summary: string;
  url: string;
  method: ContentMethod;
  plan: string;
  roadmap: string | null;
  restrictions?: string[];
  cost?: string;
  unverified?: string[];
  secretLabel?: string;
  secretHelp?: string;
  assisted?: AssistedSetup;
  oauthScopes?: string[];
  directoryOnly?: boolean;
}

const UNCHECKED = 'Not checked against the official documentation in this project.';

const EXTRAS: Extra[] = [
  // ---- blogs ----
  {
    id: 'ghost',
    name: 'Ghost',
    area: 'blogs',
    summary: 'Open-source publishing platform for blogs and paid newsletters, self-hosted or hosted.',
    url: 'https://ghost.org/docs/admin-api/',
    method: 'api_key',
    plan: 'Create a draft post through the Admin API for your own Ghost site.',
    roadmap: 'Not scheduled yet',
    restrictions: ['The Admin API is per site: you use your own site’s address and an integration key from its admin screen.'],
    cost: 'Software is free; hosted plans are paid (Ghost(Pro)).',
    unverified: ['How much access an Admin API key grants (it is not known here whether a key can be limited to posts).', UNCHECKED],
    secretLabel: 'Ghost Admin API key',
    secretHelp: 'In your Ghost admin: Settings, Integrations, Add custom integration. Copy the Admin API key.',
    assisted: { consoleUrl: 'https://ghost.org/docs/admin-api/', consoleLabel: 'Open the Ghost Admin API guide', steps: ['Sign in to your own Ghost admin screen.', 'Open Settings, then Integrations, then Add custom integration.', 'Name it “Brand OS” and copy the Admin API key and the API URL.'] },
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    area: 'blogs',
    summary: 'The most widely used blogging platform, self-hosted or on WordPress.com.',
    url: 'https://developer.wordpress.org/rest-api/',
    method: 'api_key',
    plan: 'Create a draft post through the REST API with an application password.',
    roadmap: 'Not scheduled yet',
    restrictions: ['Self-hosted sites use application passwords; WordPress.com uses its own OAuth.'],
    cost: 'Software is free; hosting varies.',
    unverified: ['Application password support depends on the site’s version and host.', UNCHECKED],
    secretLabel: 'WordPress application password',
    secretHelp: 'In your WordPress admin: Users, Profile, Application Passwords. Add one named “Brand OS” and copy it.',
    assisted: { consoleUrl: 'https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/', consoleLabel: 'Open the WordPress authentication guide', steps: ['Sign in to your own WordPress admin.', 'Open Users, then your profile, and find Application Passwords.', 'Create one named “Brand OS” and copy the password it shows once.'] },
  },
  {
    id: 'beehiiv',
    name: 'Beehiiv',
    area: 'blogs',
    summary: 'Newsletter platform with a web archive for each issue.',
    url: 'https://developers.beehiiv.com/',
    method: 'api_key',
    plan: 'Prepare a newsletter issue from the article; create a draft through the API if the plan allows it.',
    roadmap: 'Not scheduled yet',
    restrictions: ['API access and post creation may depend on the plan.'],
    cost: 'Free tier exists; paid plans add features.',
    unverified: ['Whether post creation is open to every plan.', UNCHECKED],
    secretLabel: 'Beehiiv API key',
    secretHelp: 'In Beehiiv: Settings, Integrations, API. Create a key and copy it.',
    assisted: { consoleUrl: 'https://developers.beehiiv.com/', consoleLabel: 'Open the Beehiiv developer docs', steps: ['Sign in to your own Beehiiv account.', 'Open Settings, then Integrations, then API.', 'Create a key named “Brand OS” and copy it once.'] },
  },
  {
    id: 'buttondown',
    name: 'Buttondown',
    area: 'blogs',
    summary: 'Plain-text-first newsletter service with a developer API.',
    url: 'https://docs.buttondown.com/api-introduction',
    method: 'api_key',
    plan: 'Create a newsletter draft from the article through the API.',
    roadmap: 'Not scheduled yet',
    restrictions: [],
    cost: 'Free tier exists; paid plans add subscribers and features.',
    unverified: ['Free-tier API limits.', UNCHECKED],
    secretLabel: 'Buttondown API key',
    secretHelp: 'In Buttondown: Settings, Programming. Copy your API key.',
    assisted: { consoleUrl: 'https://buttondown.com/settings/programming', consoleLabel: 'Open Buttondown programming settings', steps: ['Sign in to your own Buttondown account.', 'Open Settings, then Programming.', 'Copy the API key shown there.'] },
  },
  // ---- communities ----
  {
    id: 'lobsters',
    name: 'Lobsters',
    area: 'communities',
    summary: 'Invite-only computing link-sharing community with tagged stories.',
    url: 'https://lobste.rs/about',
    method: 'manual_only',
    plan: 'Prepare a title and link and open the submit page for you. You post it.',
    roadmap: `${PHASE2} (communities)`,
    restrictions: ['Membership is by invitation. Self-promotion is discouraged beyond a small share of your submissions.'],
    cost: 'Free.',
    unverified: ['No submission API is known; the self-promotion ratio wording is from memory.'],
  },
  {
    id: 'discord',
    name: 'Discord communities',
    area: 'communities',
    summary: 'Chat servers where you may share your work when a channel allows it.',
    url: 'https://discord.com/',
    method: 'manual_only',
    plan: 'Prepare a short message and a link to paste into a channel whose rules allow it. You post it.',
    roadmap: 'Not scheduled yet',
    restrictions: ['Each server has its own rules about self-promotion. Posting as yourself in other people’s servers is not automated.'],
    cost: 'Free.',
    unverified: [],
  },
  {
    id: 'slack',
    name: 'Slack communities',
    area: 'communities',
    summary: 'Workspaces and community Slacks where a channel may welcome your link.',
    url: 'https://slack.com/',
    method: 'manual_only',
    plan: 'Prepare a short message and a link to paste into a channel whose rules allow it. You post it.',
    roadmap: 'Not scheduled yet',
    restrictions: ['Each workspace sets its own rules. Posting in communities you do not run is not automated.'],
    cost: 'Free.',
    unverified: [],
  },
  // ---- video ----
  {
    id: 'linkedin_video',
    name: 'LinkedIn video',
    area: 'video',
    summary: 'Native video posts on your LinkedIn profile.',
    url: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api',
    method: 'oauth',
    plan: 'Upload a rendered video with a title and captions through the Videos API, after the video pipeline exists.',
    roadmap: PHASE5,
    restrictions: ['MP4, 3 seconds to 30 minutes, 75 KB to 500 MB (from the research notes).', 'Shares the LinkedIn access token, which lasts 60 days.'],
    cost: 'Free API.',
    unverified: ['Limits come from the research notes (2026-10-19) and change over time.'],
    oauthScopes: ['w_member_social'],
  },
  {
    id: 'video_other',
    name: 'Other video platforms',
    area: 'video',
    summary: 'Vimeo, TikTok, Instagram Reels and similar. Upload by hand.',
    url: 'https://vimeo.com/',
    method: 'manual_only',
    plan: 'Prepare titles, descriptions and captions to paste. You upload.',
    roadmap: PHASE5,
    restrictions: ['Each platform’s API access and rules differ and were not researched.'],
    cost: 'Varies.',
    unverified: ['No platform in this group was checked against its official documentation.'],
  },
  // ---- conferences ----
  ...(
    [
      ['sessionize', 'Sessionize', 'Call-for-speakers platform used by many conferences.', 'https://sessionize.com/', 'Speaker profile reuse and tracking of the sessions you submitted.', ['Submissions are made in each event’s Sessionize form.'], ['Whether a read API exists for a speaker’s own submissions is UNVERIFIED.']],
      ['papercall', 'PaperCall', 'Call-for-papers service used by some developer events.', 'https://www.papercall.io/', 'Tracking of submissions and deadlines.', ['Submissions are made in each event’s form.'], ['Whether an API exists for speakers is UNVERIFIED.']],
      ['kubecon', 'KubeCon + CloudNativeCon (CNCF / Linux Foundation events)', 'The Cloud Native Computing Foundation’s main conference series.', 'https://events.linuxfoundation.org/', 'Call-for-proposals dates, tracks and links.', ['Proposals are submitted through the event’s own form, which Linux Foundation events typically run on a CFP platform.'], ['Which CFP platform each edition uses is UNVERIFIED.']],
      ['srecon', 'SREcon (USENIX)', 'Site reliability engineering conferences run by USENIX.', 'https://www.usenix.org/conferences', 'Call-for-participation dates and links.', ['Submissions go through USENIX’s own system.'], ['The submission system is UNVERIFIED.']],
      ['fosdem', 'FOSDEM', 'Free and open-source developer conference held in Brussels.', 'https://fosdem.org/', 'Call-for-participation dates and devroom links.', ['Talks are proposed to individual devrooms.'], ['Submission tooling is UNVERIFIED.']],
      ['devopsdays', 'DevOpsDays', 'A worldwide series of locally organized DevOps events.', 'https://devopsdays.org/', 'Per-city CFP dates and links.', ['Every city runs its own call.'], []],
      ['platformcon', 'PlatformCon', 'Online conference about platform engineering.', 'https://platformcon.com/', 'CFP dates and links.', [], ['CFP format is UNVERIFIED.']],
      ['gophercon', 'GopherCon', 'Conferences for the Go community.', 'https://www.gophercon.com/', 'CFP dates and links.', [], ['CFP platform is UNVERIFIED.']],
      ['postgres_conferences', 'PostgreSQL conferences', 'Community conferences and meetups listed by the PostgreSQL project.', 'https://www.postgresql.org/about/events/', 'Event list with CFP dates.', ['Each event runs its own call.'], []],
    ] as const
  ).map(
    ([id, name, summary, url, plan, restrictions, unverified]): Extra => ({
      id,
      name,
      area: 'conferences',
      summary,
      url,
      method: 'manual_only',
      plan: `${plan} Directory only for now: no live CFP data is read.`,
      roadmap: PHASE4,
      restrictions: [...restrictions],
      cost: 'Free to submit, as a rule. Travel and ticket costs vary.',
      unverified: [...unverified],
      directoryOnly: true,
    }),
  ),
  // ---- editorial ----
  ...(
    [
      ['infoq', 'InfoQ', 'Software engineering news and articles written by practitioners and edited by InfoQ.', 'https://www.infoq.com/write-for-infoq/', ['Editors decide what runs. The contributor guidelines were not read in this project.']],
      ['cncf_blog', 'CNCF Blog', 'The Cloud Native Computing Foundation’s blog, with community and ambassador posts.', 'https://www.cncf.io/blog/', ['Posting rules and the submission route were not checked here.']],
      ['dzone', 'DZone', 'Developer articles site with a contributor program.', 'https://dzone.com/', ['Contributor requirements, exclusivity and syndication rules were not checked here.']],
      ['freecodecamp', 'freeCodeCamp News', 'Free tutorials and articles for learners, written by volunteers.', 'https://www.freecodecamp.org/news/', ['Its publishing guidelines and review process were not checked here.']],
      ['lf_publications', 'Linux Foundation publications', 'Blogs and newsletters run by the Linux Foundation and its projects.', 'https://www.linuxfoundation.org/blog', ['Which projects accept outside posts was not checked here.']],
      ['newsletters', 'Technical newsletters', 'Curated email newsletters that link to good technical posts.', 'https://www.google.com/search?q=curated+engineering+newsletters', ['Each newsletter has its own submission form or editor.']],
    ] as const
  ).map(
    ([id, name, summary, url, unverified]): Extra => ({
      id,
      name,
      area: 'editorial',
      summary,
      url,
      method: 'manual_only',
      plan: 'Pitch and submission tracking with the reasons an article fits, kept sources and follow-ups. Directory only for now.',
      roadmap: PHASE3,
      restrictions: ['An editor decides. Exclusivity and republishing rules differ and must be read before a pitch.'],
      cost: 'Free to pitch. Some pay contributors; this was not checked.',
      unverified: [...unverified],
      directoryOnly: true,
    }),
  ),
  // ---- launches ----
  {
    id: 'github_releases',
    name: 'GitHub Releases',
    area: 'launches',
    summary: 'Release notes and assets attached to a tag in a GitHub repository.',
    url: 'https://docs.github.com/en/rest/releases/releases',
    method: 'api_key',
    plan: 'Draft release notes from a changelog and create a draft release with your own fine-grained token.',
    roadmap: PHASE7,
    restrictions: ['Needs write access to the repository’s contents. A draft release is not public until published.'],
    cost: 'Free.',
    unverified: ['The exact fine-grained permission for creating a release was not checked here.'],
    secretLabel: 'GitHub fine-grained token',
    secretHelp: 'Create one at GitHub under Settings, Developer settings, Fine-grained tokens, limited to the one repository.',
    assisted: { consoleUrl: 'https://github.com/settings/personal-access-tokens/new', consoleLabel: 'Open GitHub token settings', steps: ['Choose “Only select repositories” and pick the project’s repository.', 'Give it the repository permission needed for releases (Contents: read and write).', 'Generate the token and copy it once.'] },
  },
  {
    id: 'product_hunt',
    name: 'Product Hunt',
    area: 'launches',
    summary: 'A daily list of new products with community voting.',
    url: 'https://api.producthunt.com/v2/docs',
    method: 'browser_assisted',
    plan: 'Prepare a launch checklist, tagline, description and gallery text. You launch it.',
    roadmap: PHASE7,
    restrictions: ['Launching is done on the website by a person.'],
    cost: 'Free to launch.',
    unverified: ['Whether the public API allows creating a post is UNVERIFIED and assumed not.', 'Launch rules (timing, upvote requests) were not checked here.'],
    secretLabel: 'Product Hunt developer token',
    secretHelp: 'Create an API application under your Product Hunt account’s API dashboard.',
    assisted: { consoleUrl: 'https://www.producthunt.com/v2/oauth/applications', consoleLabel: 'Open the Product Hunt API dashboard', steps: ['Sign in to your own Product Hunt account.', 'Add an application named “Brand OS”.', 'Copy the client ID, client secret and developer token it shows.'] },
  },
  {
    id: 'show_hn',
    name: 'Show HN',
    area: 'launches',
    summary: 'The Hacker News category for projects you made and that people can try.',
    url: 'https://news.ycombinator.com/showhn.html',
    method: 'manual_only',
    plan: 'Check the Show HN rules against your project and open a pre-filled submit link. You submit it.',
    roadmap: `${PHASE2} (Day 10)`,
    restrictions: ['Show HN has its own guidelines (something people can try, no sign-up wall). Read them first.'],
    cost: 'Free.',
    unverified: [],
  },
  ...(
    [
      ['npm', 'npm registry', 'Package registry for JavaScript.', 'https://docs.npmjs.com/'],
      ['pypi', 'PyPI', 'Package index for Python.', 'https://pypi.org/help/'],
      ['crates', 'crates.io', 'Package registry for Rust.', 'https://doc.rust-lang.org/cargo/reference/publishing.html'],
    ] as const
  ).map(
    ([id, name, summary, url]): Extra => ({
      id,
      name,
      area: 'launches',
      summary,
      url,
      method: 'manual_only',
      plan: 'A release checklist and the exact publish command to run yourself. The app does not publish packages.',
      roadmap: PHASE7,
      restrictions: ['A published version cannot be replaced. Publishing is done with the registry’s own tool and your own login.'],
      cost: 'Free.',
      unverified: ['Registry policies (unpublishing, token scopes) were not checked here.'],
    }),
  ),
  // ---- aggregators ----
  {
    id: 'buffer',
    name: 'Buffer',
    area: 'aggregators',
    summary: 'A scheduler that posts to many social channels from one place.',
    url: 'https://buffer.com/developers',
    method: 'browser_assisted',
    plan: 'Optional adapter that hands approved posts to Buffer instead of each platform.',
    roadmap: PHASE2,
    restrictions: ['A third party would hold your channel connections.'],
    cost: 'Free and paid plans exist.',
    unverified: ['Whether new developer applications are being accepted is UNVERIFIED.', UNCHECKED],
    secretLabel: 'Buffer access token',
    secretHelp: 'Create an application in Buffer’s developer area, if new ones are accepted, and copy its access token.',
    assisted: { consoleUrl: 'https://buffer.com/developers/apps', consoleLabel: 'Open Buffer’s developer area', steps: ['Sign in to your own Buffer account.', 'Open the developer area and create an application named “Brand OS”.', 'Copy the access token it shows once.'] },
  },
  {
    id: 'postiz',
    name: 'Postiz',
    area: 'aggregators',
    summary: 'An open-source social media scheduler you can host yourself.',
    url: 'https://postiz.com/',
    method: 'api_key',
    plan: 'Optional adapter that hands approved posts to your own Postiz instance.',
    roadmap: PHASE2,
    restrictions: ['Self-hosting is yours to run. A hosted plan would hold your channel connections.'],
    cost: 'Free to self-host; paid hosted plans exist.',
    unverified: ['Its public API shape and any rate limits were not checked here.'],
    secretLabel: 'Postiz API key',
    secretHelp: 'In your Postiz settings, create an API key and copy it.',
    assisted: { consoleUrl: 'https://postiz.com/', consoleLabel: 'Open Postiz', steps: ['Open your own Postiz instance and sign in.', 'Open Settings and find the API key section.', 'Create or copy a key.'] },
  },
];

const AREA_OF: Record<PlatformId, Area> = {
  devto: 'blogs',
  hashnode: 'blogs',
  site: 'blogs',
  medium: 'blogs',
  substack: 'blogs',
  linkedin: 'social',
  x: 'social',
  bluesky: 'social',
  threads: 'social',
  mastodon: 'social',
  reddit: 'communities',
  hackernews: 'communities',
  youtube: 'video',
};

const URL_OF: Record<PlatformId, string> = {
  devto: 'https://developers.forem.com/api/v1',
  hashnode: 'https://apidocs.hashnode.com/',
  site: 'https://docs.github.com/en/rest',
  medium: 'https://help.medium.com/hc/en-us/articles/213480228-API-Importing',
  substack: 'https://support.substack.com/',
  linkedin: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api',
  x: 'https://docs.x.com/x-api/getting-started/pricing',
  bluesky: 'https://docs.bsky.app/',
  threads: 'https://developers.facebook.com/docs/threads/',
  mastodon: 'https://docs.joinmastodon.org/methods/statuses/',
  reddit: 'https://www.reddit.com/wiki/api/',
  hackernews: 'https://news.ycombinator.com/newsguidelines.html',
  youtube: 'https://developers.google.com/youtube/v3/docs/videos/insert',
};

const METHOD_OF: Record<PlatformId, ContentMethod> = {
  devto: 'api_key',
  hashnode: 'api_key',
  site: 'api_key',
  medium: 'manual_only',
  substack: 'manual_only',
  linkedin: 'oauth',
  x: 'oauth',
  bluesky: 'api_key',
  threads: 'oauth',
  mastodon: 'oauth',
  reddit: 'manual_only',
  hackernews: 'manual_only',
  youtube: 'oauth',
};

const WHAT_IT_IS: Record<PlatformId, string> = {
  devto: 'Developer community and publishing platform, built on Forem.',
  hashnode: 'Blogging platform for developers, with custom domains.',
  site: 'Your own site, kept in a Git repository.',
  medium: 'General-purpose publishing platform and reading network.',
  substack: 'Newsletter and publishing platform.',
  linkedin: 'Professional network: short posts that point to your article.',
  x: 'Short posts and threads.',
  bluesky: 'Open social network for short posts.',
  threads: 'Meta’s network for short text posts.',
  mastodon: 'Federated social network run by independent servers.',
  reddit: 'Communities that discuss links and posts, each with its own rules.',
  hackernews: 'Link-sharing and discussion site run by Y Combinator.',
  youtube: 'Video platform for long videos and Shorts.',
};

function fromCatalog(id: PlatformId): DirectoryEntry {
  const info = PLATFORMS[id];
  const adapter = info.state === 'adapter';
  return {
    id,
    name: info.name,
    area: AREA_OF[id],
    summary: WHAT_IT_IS[id],
    url: URL_OF[id],
    method: METHOD_OF[id],
    plan: adapter ? 'Built: private drafts, an exact-payload approval and publishing.' : info.state === 'manual_only' ? 'Preview, edit and copy for manual posting, with a pre-filled link where the platform has one.' : `Preview and manual posting now; publishing through the platform when it arrives.`,
    roadmap: adapter ? null : info.roadmap,
    restrictions: info.capabilities.restrictions,
    cost: info.capabilities.cost,
    unverified: info.unverified,
    composer: id,
    adapter,
    secretLabel: info.secretLabel,
    secretHelp: info.secretHelp,
    assisted: info.connect.steps.length > 0 ? { consoleUrl: info.connect.openUrl, consoleLabel: info.connect.openLabel, steps: info.connect.steps } : null,
    oauth: info.connect.oauth ? { scopes: info.connect.oauth.scopes, redirectPath: info.connect.oauth.redirectPath, register: info.connect.oauth.register, note: info.connect.oauth.note } : null,
    directoryOnly: false,
  };
}

function fromExtra(extra: Extra): DirectoryEntry {
  const oauthRedirect = `/api/connect/${extra.id}/callback`;
  return {
    id: extra.id,
    name: extra.name,
    area: extra.area,
    summary: extra.summary,
    url: extra.url,
    method: extra.method,
    plan: extra.plan,
    roadmap: extra.roadmap,
    restrictions: extra.restrictions ?? [],
    cost: extra.cost ?? 'Not checked.',
    unverified: extra.unverified ?? [],
    composer: null,
    adapter: false,
    secretLabel: extra.secretLabel ?? '',
    secretHelp: extra.secretHelp ?? '',
    assisted: extra.assisted ?? null,
    oauth: extra.method === 'oauth' ? { scopes: extra.oauthScopes ?? [], redirectPath: oauthRedirect, register: ['An application registered in the platform’s developer console'], note: 'OAuth connections arrive with the next task after Day 6.' } : null,
    directoryOnly: extra.directoryOnly ?? false,
  };
}

/** Every entry, in the order the areas appear and, inside an area, the composer destinations first. */
export const DIRECTORY: readonly DirectoryEntry[] = [...PLATFORM_IDS.map(fromCatalog), ...EXTRAS.map(fromExtra)].sort((a, b) => AREAS.indexOf(a.area) - AREAS.indexOf(b.area));

export function directoryEntry(id: string): DirectoryEntry | undefined {
  return DIRECTORY.find((entry) => entry.id === id);
}

export function isDirectoryId(id: unknown): id is string {
  return typeof id === 'string' && DIRECTORY.some((entry) => entry.id === id);
}

export function entriesIn(area: Area): DirectoryEntry[] {
  return DIRECTORY.filter((entry) => entry.area === area);
}

/** The status a card shows, from the entry and whether its connection works. */
export function directoryStatus(entry: DirectoryEntry, connected: boolean): DirectoryStatus {
  if (entry.composer) {
    const state: PublishingState = publishingState(entry.composer, connected);
    if (state === 'available') return 'available_now';
    if (state === 'connect_required') return 'needs_connection';
    if (state === 'coming_later') return 'planned';
    return state;
  }
  return entry.method === 'manual_only' && !entry.directoryOnly ? 'manual_only' : 'planned';
}

/** One line for a card: why it is not actionable, with the roadmap phase where there is one. */
export function statusLine(entry: DirectoryEntry, status: DirectoryStatus): string {
  if (status === 'available_now') return 'Ready: connect, prepare, approve and publish.';
  if (status === 'needs_connection') return 'Built. Connect an account to stage and publish.';
  if (status === 'preview_only') return entry.composer ? PLATFORMS[entry.composer].reason : 'Preview only.';
  if (status === 'manual_only') return entry.composer ? PLATFORMS[entry.composer].reason : 'No API: the app prepares it and you post it.';
  const where = entry.roadmap ? `Planned: ${entry.roadmap}.` : 'Planned. Not scheduled yet.';
  return entry.directoryOnly ? `${where} Directory only: no live data is read.` : where;
}

/** The text for a person’s own Claude with browser access. It asks for the setup steps only; the secret never passes through chat. */
export function assistedPrompt(entry: DirectoryEntry, appUrl: string): string {
  const lines = [
    `I need to create API access for ${entry.name} so my own app (Brand OS, running at ${appUrl}) can use it later. Please help me do it in my browser. I am already signed in.`,
    '',
    entry.assisted ? `Start at: ${entry.assisted.consoleUrl}` : `Start at: ${entry.url}`,
    '',
    'Do exactly this and nothing else:',
    ...(entry.assisted?.steps ?? ['Find where the platform creates an API key or an application.']).map((step, i) => `${i + 1}. ${step}`),
  ];
  if (entry.oauth) {
    lines.push('', 'When it asks for them, use:', `- Redirect URL: ${appUrl}${entry.oauth.redirectPath}`, `- Scopes: ${entry.oauth.scopes.join(', ') || 'the minimum the platform allows'}`);
  }
  lines.push(
    '',
    'Rules:',
    '- Never post, publish, send or change anything on my account other than creating this one application or key.',
    '- Do not ask me to paste any secret, key or password into this chat, and do not write them in your replies.',
    '- When the platform shows the key or secret, stop and tell me which fields to copy. I will paste them into the secure field in Brand OS myself.',
    '- If a step asks for a payment, a verification code or a decision about billing, stop and ask me.',
  );
  return lines.join('\n');
}

export function redirectUrl(entry: DirectoryEntry, appUrl: string): string | null {
  return entry.oauth ? `${appUrl.replace(/\/$/, '')}${entry.oauth.redirectPath}` : null;
}

/** What kind of secret the Setup card collects for an entry that has no working adapter yet. */
export type SecretKind = 'api_key' | 'oauth_client';

export function setupKinds(entry: DirectoryEntry): SecretKind[] {
  if (entry.adapter) return [];
  if (entry.method === 'oauth') return ['oauth_client'];
  if (entry.method === 'api_key' || entry.method === 'browser_assisted') return ['api_key'];
  return [];
}

import type { ConnectorDefinition } from './types';
import type { ConnectorId } from './ids';

/*
 * Platforms with no official API, no self-serve access to one, or no connection to make (directory entries for events
 * and publications). Each says why and what the person does instead; none invents an endpoint. The reasons were read
 * on the platforms' own pages on 2026-10-24 where a page exists, otherwise they come from the research notes in
 * docs/research and INTEGRATIONS.md and are marked as such.
 */

const CHECKED = '2026-10-24' as const;

interface ManualRow {
  id: ConnectorId;
  name: string;
  reason: string;
  handoff: string[];
  openUrl: string;
  openLabel: string;
  sources: string[];
  unverified?: string[];
  /** A directory-only entry shows Planned until its roadmap phase; the others show Manual. */
  planned?: boolean;
}

const ROWS: ManualRow[] = [
  {
    id: 'medium',
    name: 'Medium',
    reason: 'Medium no longer issues integration tokens and has said it will not allow new integrations. Existing tokens keep working, but nobody can get a new one.',
    handoff: ['Copy the prepared text, or paste your canonical address into Medium\'s Import a story tool, which sets the canonical link for you.', 'Publish it yourself, then paste the link of the live post back into the app.'],
    openUrl: 'https://medium.com/p/import',
    openLabel: 'Open Medium\'s import tool',
    sources: ['https://help.medium.com/hc/en-us/articles/213480228-API-Importing', 'https://help.medium.com/hc/en-us/articles/214550207-Importing-a-post-to-Medium'],
    unverified: ['Whether an old token still publishes was not tested. The Medium help page could not be fetched on 2026-10-24; the statement is from INTEGRATIONS.md, checked 2026-10-21.'],
  },
  {
    id: 'substack',
    name: 'Substack',
    reason: 'Substack has no public publishing API, and unofficial libraries that draft posts break its terms.',
    handoff: ['Copy the prepared text and paste it into a new post.', 'Keep the "Originally published at" line, because Substack has no canonical field.', 'Publish it yourself and paste the link back.'],
    openUrl: 'https://substack.com/',
    openLabel: 'Open Substack',
    sources: ['https://support.substack.com/'],
    unverified: ['Not re-checked on 2026-10-24; the statement is from docs/research/01-longform-platforms.md (2026-10-19).'],
  },
  {
    id: 'reddit',
    name: 'Reddit',
    reason: 'Reddit requires approval for new API access and refuses many personal scripts, so there is no self-serve way to connect. Automated link posts also risk a ban.',
    handoff: ['Read the subreddit\'s rules first; many ban self-promotion.', 'Open the pre-filled submit page, check the title and body, and submit it yourself.', 'Paste the link of the post back.'],
    openUrl: 'https://www.reddit.com/submit',
    openLabel: 'Open Reddit\'s submit page',
    sources: ['https://www.reddit.com/wiki/api/'],
    unverified: ['The approval requirement is from a mirror of an administrator post and a third-party report (docs/research/02-social-platforms.md); the official policy page was not read.'],
  },
  {
    id: 'hackernews',
    name: 'Hacker News',
    reason: 'Hacker News has no API for submitting stories. Its public API is read-only.',
    handoff: ['Open the pre-filled submit page and use the title as written.', 'Submit it yourself while signed in.', 'Open your submission and paste its link back (it contains item?id=).'],
    openUrl: 'https://news.ycombinator.com/submit',
    openLabel: 'Open the submit page',
    sources: ['https://news.ycombinator.com/newsguidelines.html'],
    unverified: ['The absence of a write API is from the research notes; the guidelines page does not say it.'],
  },
  {
    id: 'lobsters',
    name: 'Lobsters',
    reason: 'Lobsters is invitation only and documents no submission API.',
    handoff: ['Prepare a title and a link, then open the submit page while signed in.', 'Keep self-promotion to a small share of what you submit.', 'Submit it yourself.'],
    openUrl: 'https://lobste.rs/about',
    openLabel: 'Open Lobsters',
    sources: ['https://lobste.rs/about'],
    unverified: ['No submission API is known; the self-promotion wording is from memory.'],
  },
  {
    id: 'video_other',
    name: 'Other video platforms',
    reason: 'Vimeo, TikTok and Instagram Reels each have their own access rules and none was researched, so nothing is connected.',
    handoff: ['Copy the title, description and captions the app prepares.', 'Upload the video yourself on the platform.'],
    openUrl: 'https://vimeo.com/',
    openLabel: 'Open Vimeo',
    sources: ['https://vimeo.com/'],
    unverified: ['No platform in this group was checked against its official documentation.'],
  },
  ...(
    [
      ['sessionize', 'Sessionize', 'https://sessionize.com/', 'Whether a speaker can read their own submissions over an API is unverified. Submissions are made in each event\'s own form.'],
      ['papercall', 'PaperCall', 'https://www.papercall.io/', 'Whether an API exists for speakers is unverified. Submissions are made in each event\'s own form.'],
      ['kubecon', 'KubeCon + CloudNativeCon', 'https://events.linuxfoundation.org/', 'Each edition runs its own call for proposals on a platform that can change.'],
      ['srecon', 'SREcon', 'https://www.usenix.org/conferences', 'Submissions go through USENIX\'s own system.'],
      ['fosdem', 'FOSDEM', 'https://fosdem.org/', 'Talks are proposed to individual devrooms, each with its own process.'],
      ['devopsdays', 'DevOpsDays', 'https://devopsdays.org/', 'Every city runs its own call for proposals.'],
      ['platformcon', 'PlatformCon', 'https://platformcon.com/', 'The call for proposals format is not documented here.'],
      ['gophercon', 'GopherCon', 'https://www.gophercon.com/', 'The call for proposals platform is not documented here.'],
      ['postgres_conferences', 'PostgreSQL conferences', 'https://www.postgresql.org/about/events/', 'Each event runs its own call.'],
    ] as const
  ).map(
    ([id, name, openUrl, why]): ManualRow => ({
      id,
      name,
      reason: `There is nothing to connect: a conference call for proposals is a form on the event's own site. ${why}`,
      handoff: ['Open the event page and read the call for proposals.', 'Note the deadline in your own calendar. Reminders arrive with the conference phase of the roadmap.', 'Submit through the event\'s own form.'],
      openUrl,
      openLabel: `Open ${name}`,
      sources: [openUrl],
      unverified: ['The deadlines and the form are the event\'s to publish; none is read by this app.'],
      planned: true,
    }),
  ),
  ...(
    [
      ['infoq', 'InfoQ', 'https://www.infoq.com/write-for-infoq/'],
      ['cncf_blog', 'CNCF Blog', 'https://www.cncf.io/blog/'],
      ['dzone', 'DZone', 'https://dzone.com/'],
      ['freecodecamp', 'freeCodeCamp News', 'https://www.freecodecamp.org/news/'],
      ['lf_publications', 'Linux Foundation publications', 'https://www.linuxfoundation.org/blog'],
      ['newsletters', 'Technical newsletters', 'https://www.google.com/search?q=curated+engineering+newsletters'],
    ] as const
  ).map(
    ([id, name, openUrl]): ManualRow => ({
      id,
      name,
      reason: 'An editor decides what runs, so you pitch rather than connect an account. Exclusivity and republishing rules differ and were not read in this project.',
      handoff: ['Read the publication\'s contributor guidelines.', 'Send your pitch through the route they name.'],
      openUrl,
      openLabel: `Open ${name}`,
      sources: [openUrl],
      unverified: ['Contributor requirements, exclusivity and syndication rules were not checked.'],
      planned: true,
    }),
  ),
  {
    id: 'show_hn',
    name: 'Show HN',
    reason: 'Show HN is a category on Hacker News, which has no submission API.',
    handoff: ['Check your project against the Show HN rules: something people can try, no sign-up wall.', 'Open the submit page and submit it yourself.'],
    openUrl: 'https://news.ycombinator.com/showhn.html',
    openLabel: 'Open the Show HN rules',
    sources: ['https://news.ycombinator.com/showhn.html'],
  },
  ...(
    [
      ['npm', 'npm registry', 'https://docs.npmjs.com/', 'npm publish'],
      ['pypi', 'PyPI', 'https://pypi.org/help/', 'twine upload'],
      ['crates', 'crates.io', 'https://doc.rust-lang.org/cargo/reference/publishing.html', 'cargo publish'],
    ] as const
  ).map(
    ([id, name, openUrl, command]): ManualRow => ({
      id,
      name,
      reason: 'A published version cannot be replaced, so this app never publishes packages. You publish with the registry\'s own tool and your own login.',
      handoff: [`Follow the release checklist the app prepares, then run ${command} yourself.`],
      openUrl,
      openLabel: `Open the ${name} documentation`,
      sources: [openUrl],
      unverified: ['Registry policies on unpublishing and token scopes were not checked.'],
    }),
  ),
];

export const MANUAL_DEFINITIONS: ConnectorDefinition[] = ROWS.map((row) => ({
  id: row.id,
  name: row.name,
  kind: 'manual_only',
  summary: `No connection to make. ${row.reason.split('. ')[0]}.`,
  fields: [],
  steps: [],
  scopes: [],
  endpoints: {},
  manual: { reason: row.reason, handoff: row.handoff, openUrl: row.openUrl as `https://${string}`, openLabel: row.openLabel },
  states: row.planned ? ['planned'] : ['manual'],
  verification: { level: row.unverified && row.unverified.length > 0 ? 'unverified' : 'verified', checkedOn: CHECKED, sources: row.sources, unverified: row.unverified ?? [] },
  docsUrl: row.sources[0] as string,
}));

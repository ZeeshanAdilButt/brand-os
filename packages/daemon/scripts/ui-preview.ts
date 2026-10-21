// Renders every dashboard page with made-up data into static HTML files, for looking at the design
// in a browser without starting a daemon. Pure view functions only: no database, no secrets, no
// network, no state directory. Run from the repo root:
//
//   npx tsx packages/daemon/scripts/ui-preview.ts [outDir]
//
// The default outDir is .superpowers/ui-preview (not committed).
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Draft } from '@cph/core';
import type { Approval, AuditRow, ContentRow } from '../src/db/repos.js';
import type { BudgetSnapshot } from '../src/services/api-budget.js';
import type { ConnectionView } from '../src/services/connections.js';
import { approvalsView } from '../src/http/views/approvals.js';
import { connectBufferCard } from '../src/http/views/connect-buffer.js';
import { connectDevtoCard } from '../src/http/views/connect-devto.js';
import { connectionsView } from '../src/http/views/connections.js';
import { contentMatrix } from '../src/http/views/content.js';
import { draftSection } from '../src/http/views/draft.js';
import { draftsList } from '../src/http/views/drafts.js';
import { html, type SafeHtml } from '../src/http/views/html.js';
import { DASHBOARD_JS, errorPage, layout, notice, signInPage, type NavPage, type PageContext } from '../src/http/views/layout.js';
import { logView } from '../src/http/views/log.js';
import { settingsView } from '../src/http/views/settings.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, '..', '..', '..', '.superpowers', 'ui-preview'));
mkdirSync(out, { recursive: true });

const CSRF = 'preview-csrf-not-a-real-token';
const SLUG = 'prometheus-cardinality-explained';
const HASH_A = 'a3f91c07' + '5e'.repeat(28);
const HASH_B = '7c2d04be' + '91'.repeat(28);
const HASH_C = 'e0b8a6d2' + '4f'.repeat(28);

const LINKEDIN_TEXT = `Prometheus cost follows series count, not sample count.

Most teams look at scrape interval when the bill goes up. The real driver is cardinality: every unique label combination is its own time series, with its own memory and index entries.

Three things I check first:
1. Labels holding user IDs, request IDs or full URLs
2. Histograms with too many buckets on high-traffic routes
3. Exporters shipping every Kubernetes label by default

I wrote up how to find the worst offenders with one PromQL query, and how we cut series by 71% without losing a single dashboard.

https://www.example-blog.dev/blog/${SLUG}

#prometheus #observability #sre`;

const DEVTO_BODY = `Prometheus bills you in **series**, not samples. If your memory graph only goes up, the culprit is almost always a label.

## Why cardinality is the real cost

Every unique combination of label values is a separate time series. A metric with \`route\`, \`status\` and \`pod\` labels can quietly multiply into tens of thousands of series.

> A label is a promise to store one more series per value, forever.

### Find the worst offenders

Run this in the Prometheus UI:

\`\`\`promql
topk(10, count by (__name__)({__name__=~".+"}))
\`\`\`

Then look for these patterns:

- labels that hold user IDs or request IDs
- histograms with 30+ buckets on busy routes
- exporters that copy every Kubernetes label

1. Drop the label at scrape time with \`metric_relabel_configs\`
2. Aggregate in a recording rule
3. Re-check the series count a day later

See the [full write-up](https://www.example-blog.dev/blog/${SLUG}) for the relabel config we used.

{% embed https://www.example-blog.dev/blog/${SLUG} %}

---

*Originally published at [example-blog.dev](https://www.example-blog.dev/blog/${SLUG}).*`;

const T = (minutes: number): string => new Date(Date.UTC(2026, 9, 20, 9, 30) + minutes * 60_000).toISOString();

function draft(overrides: Partial<Draft> & Pick<Draft, 'id' | 'platform' | 'route' | 'payload'>): Draft {
  return {
    slug: SLUG,
    account: 'default',
    kind: 'post',
    status: 'pending_approval',
    payloadSha256: HASH_A,
    authorship: 'ai-assisted',
    lint: [],
    createdAt: T(-120),
    updatedAt: T(-15),
    ...overrides,
  } as Draft;
}

const linkedin = draft({
  id: 'd-linkedin-01',
  platform: 'linkedin',
  route: 'buffer',
  payload: { text: LINKEDIN_TEXT },
  notBefore: T(60 * 24),
  lint: [
    { rule: 'hashtags.max', severity: 'warning', message: 'Three hashtags is the most LinkedIn shows inline; keep it at three.' },
    { rule: 'link.position', severity: 'warning', message: 'The link sits mid-post; LinkedIn may cut the text before it.' },
  ],
});
const devto = draft({
  id: 'd-devto-01',
  platform: 'devto',
  route: 'direct',
  kind: 'article',
  status: 'staged',
  payloadSha256: HASH_B,
  authorship: 'reformatted',
  remoteRef: '2190447',
  payload: {
    title: 'Prometheus cardinality, explained: why your bill follows series count',
    canonical_url: `https://www.example-blog.dev/blog/${SLUG}`,
    description: 'Find the labels that multiply your series, and cut them without losing dashboards.',
    tags: ['prometheus', 'observability', 'sre', 'devops'],
    main_image: `https://www.example-blog.dev/images/blog/${SLUG}/cover.png`,
    series: 'Observability internals',
    body_markdown: DEVTO_BODY,
  },
});
const unknown = draft({
  id: 'd-linkedin-00',
  platform: 'linkedin',
  route: 'buffer',
  status: 'unknown',
  payloadSha256: HASH_C,
  payload: { text: 'An earlier LinkedIn post.' },
  failureReason: 'Buffer timed out after 30 s while sharing the post; it may be live.',
});
const failedDraft = draft({
  id: 'd-devto-00',
  platform: 'devto',
  route: 'direct',
  kind: 'article',
  status: 'failed',
  payloadSha256: HASH_C,
  payload: { title: 'Old title', body_markdown: 'x' },
  lint: [
    { rule: 'canonical.missing', severity: 'error', message: 'canonical_url is empty: dev.to would rank above the original post.' },
    { rule: 'tags.max', severity: 'error', message: 'dev.to allows at most 4 tags; this draft has 6.' },
    { rule: 'title.length', severity: 'warning', message: 'Titles over 70 characters are cut in the feed.' },
  ],
  updatedAt: T(-600),
});

const approval = (id: string, d: Draft, minutes: number): Approval =>
  ({ id, draftId: d.id, payloadSha256: d.payloadSha256, channel: 'dashboard_hello', mode: 'publish_now', status: 'pending', expiresAt: T(minutes) }) as Approval;

const budget = { m15: { remaining: 98, limit: 100 }, d1: { remaining: 241, limit: 250 }, d30: { remaining: 2968, limit: 3000 } } as unknown as BudgetSnapshot;

const LINKEDIN_CHECKLIST = [
  'The post reads well on its own, without the article',
  'The link goes to the canonical post on example-blog.dev',
  'No client names, internal numbers or anything under NDA',
  'Posting as the owner on LinkedIn is what I want',
];
const DEVTO_CHECKLIST = [
  'canonical_url points at example-blog.dev',
  'The cover image and tags are right',
  'Code blocks and the embed render on dev.to',
];

const ctx = (overrides: Partial<PageContext> = {}): PageContext => ({
  csrf: CSRF,
  publishingEnabled: false,
  bufferBudgetLow: false,
  secretsReady: true,
  approvalMode: 'hello',
  pendingApprovals: 2,
  holds: 1,
  ...overrides,
});

const connections: ConnectionView[] = [
  { platform: 'devto', route: 'direct', account: 'default', active: true, state: 'connected', who: '@owner_adil', checkedAt: T(-30) },
  {
    platform: 'linkedin',
    route: 'buffer',
    account: 'default',
    active: true,
    state: 'expiring',
    who: 'The owner',
    detail: 'Buffer says the LinkedIn token expires in 6 days.',
    nextAction: 'Reconnect LinkedIn inside Buffer before it lapses.',
    checkedAt: T(-30),
  },
  {
    platform: 'linkedin',
    route: 'assist',
    account: 'default',
    active: false,
    state: 'needs_reconnect',
    nextAction: 'Sign in to LinkedIn in your browser, then run the check again.',
  },
];

const contentRows: ContentRow[] = [
  { slug: SLUG, canonicalUrl: '', title: 'Prometheus cardinality, explained', date: '2026-10-12', mdxSha256: '', repoCommit: '', dirty: false, published: true, canonicalLiveAt: T(-3000), syncedAt: T(-5) },
  { slug: 'kafka-consumer-lag-is-a-symptom', canonicalUrl: '', title: 'Kafka consumer lag is a symptom', date: '2026-10-02', mdxSha256: '', repoCommit: '', dirty: true, published: true, syncedAt: T(-5) },
  { slug: 'postgres-vacuum-in-plain-words', canonicalUrl: '', title: 'Postgres VACUUM in plain words', date: '2026-09-21', mdxSha256: '', repoCommit: '', dirty: false, published: false, syncedAt: T(-5) },
] as ContentRow[];

const audit: AuditRow[] = [
  { id: 9, ts: T(-2), actorChannel: 'mcp', action: 'approval_requested', platform: 'linkedin', draftId: linkedin.id, detail: { approvalId: 'ap-01', tag: '#A3F91C07' } },
  { id: 8, ts: T(-3), actorChannel: 'mcp', action: 'staged', platform: 'devto', draftId: devto.id, detail: { remoteRef: '2190447' } },
  { id: 7, ts: T(-9), actorChannel: 'dashboard', action: 'signed_in' },
  { id: 6, ts: T(-14), actorChannel: 'mcp', action: 'draft_created', platform: 'linkedin', draftId: linkedin.id, detail: { lint: { errors: 0, warnings: 2 } } },
  { id: 5, ts: T(-40), actorChannel: 'dashboard_hello', action: 'publishing_enabled' },
  { id: 4, ts: T(-41), actorChannel: 'daemon', action: 'publish_unknown', platform: 'linkedin', draftId: unknown.id, detail: { error: 'timed out' } },
] as AuditRow[];

function page(name: string, title: string, nav: NavPage | undefined, content: SafeHtml, c: PageContext = ctx()): void {
  write(name, layout(title, nav, c, content));
}

function write(name: string, doc: SafeHtml): void {
  const local = doc.value
    .replace('href="/static/app.css"', 'href="app.css"')
    .replace('src="/static/htmx.min.js"', 'src="htmx.min.js"')
    .replace('src="/static/dashboard.js"', 'src="dashboard.js"');
  writeFileSync(join(out, `${name}.html`), local);
}

const linkedinCard = {
  csrf: CSRF,
  approval: approval('ap-01', linkedin, 22),
  draft: linkedin,
  state: 'pending',
  checklist: LINKEDIN_CHECKLIST,
  channelName: 'The owner',
  costUsd: 0,
  budget,
};
const devtoCard = { csrf: CSRF, approval: approval('ap-02', devto, 48), draft: devto, state: 'pending', checklist: DEVTO_CHECKLIST, costUsd: 0 };

page(
  'approvals',
  'Approvals',
  'approvals',
  approvalsView({ red: [{ csrf: CSRF, kind: 'unknown', draft: unknown, reason: unknown.failureReason as string }], cards: [linkedinCard, devtoCard] }),
);
page('approvals-click', 'Approvals', 'approvals', approvalsView({ red: [], cards: [{ ...linkedinCard, click: true }] }), ctx({ approvalMode: 'click', holds: 0, pendingApprovals: 1 }));
page(
  'approvals-decided',
  'Approval',
  'approvals',
  approvalsView({
    red: [],
    cards: [{ ...linkedinCard, state: 'published', notice: notice('ok', html`Published (Windows Hello verified): <a href="https://www.linkedin.com/feed/">https://www.linkedin.com/feed/</a>`) }],
    single: true,
  }),
  ctx({ publishingEnabled: true }),
);
page('approvals-empty', 'Approvals', 'approvals', approvalsView({ red: [], cards: [] }), ctx({ pendingApprovals: 0, holds: 0 }));
page('drafts', 'Drafts', 'drafts', draftsList([linkedin, devto, unknown, failedDraft]));
page('drafts-empty', 'Drafts', 'drafts', draftsList([]));
page('draft-linkedin', 'Draft', 'drafts', draftSection({ csrf: CSRF, draft: linkedin }));
page('draft-devto', 'Draft', 'drafts', draftSection({ csrf: CSRF, draft: failedDraft }));
page('draft-devto-staged', 'Draft', 'drafts', draftSection({ csrf: CSRF, draft: devto }));
page(
  'content',
  'Content',
  'content',
  contentMatrix(
    contentRows.map((content, i) => ({
      content,
      latest: i === 0 ? { devto, linkedin } : i === 1 ? { devto: failedDraft } : {},
    })),
  ),
);
page('content-empty', 'Content', 'content', contentMatrix([]));
page('connections', 'Connections', 'connections', connectionsView(connections));
page('connect-devto', 'Connect dev.to', 'connections', connectDevtoCard({ csrf: CSRF, connection: connections[0] as ConnectionView }));
page(
  'connect-buffer',
  'Connect Buffer',
  'connections',
  connectBufferCard({
    csrf: CSRF,
    connection: connections[1] as ConnectionView,
    channels: [
      { id: 'ch-1', name: 'The owner' },
      { id: 'ch-2', name: 'example-blog (page)' },
    ],
    mappedChannelId: 'ch-1',
    notice: notice('ok', html`Connected as <strong>The owner</strong>. The key is stored encrypted and is never shown again.`),
  }),
);
page(
  'settings',
  'Settings',
  'settings',
  settingsView({ csrf: CSRF, publishingEnabled: true, dryRun: [{ platform: 'devto', on: false }, { platform: 'linkedin', on: true }] }),
  ctx({ publishingEnabled: true, bufferBudgetLow: true }),
);
page('settings-off', 'Settings', 'settings', settingsView({ csrf: CSRF, publishingEnabled: false, dryRun: [{ platform: 'devto', on: true }, { platform: 'linkedin', on: true }] }), ctx({ secretsReady: false }));
page('log', 'Log', 'log', logView(audit));
page('log-empty', 'Log', 'log', logView([]));
write('signin', signInPage());
write('error', errorPage('Sign-in link not valid', 'This sign-in link was already used or has expired.'));

copyFileSync(join(here, '..', 'src', 'http', 'static', 'app.css'), join(out, 'app.css'));
copyFileSync(join(here, '..', 'src', 'http', 'static', 'htmx.min.js'), join(out, 'htmx.min.js'));
writeFileSync(join(out, 'dashboard.js'), DASHBOARD_JS);

const index = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>UI preview</title><link rel="stylesheet" href="app.css"></head>
<body><main><h1>UI preview</h1><ul>${[
  'approvals', 'approvals-click', 'approvals-decided', 'approvals-empty', 'drafts', 'drafts-empty', 'draft-linkedin', 'draft-devto', 'draft-devto-staged',
  'content', 'content-empty', 'connections', 'connect-devto', 'connect-buffer', 'settings', 'settings-off', 'log', 'log-empty', 'signin', 'error',
].map((n) => html`<li><a href="${n}.html">${n}</a></li>`)}</ul></main></body></html>`;
writeFileSync(join(out, 'index.html'), index.value);
console.log(`wrote the UI preview to ${out}`);

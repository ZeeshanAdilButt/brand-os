import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildContentItem, DEFAULT_BASE_URL, withUtm, type ContentItem } from '@cph/core';
import { ConfigSchema, type Config } from '../../src/config.js';
import { createAudit, type Audit } from '../../src/audit.js';
import { openDb, type Db } from '../../src/db/open.js';
import { createRepos, type ApprovalMode, type Repos } from '../../src/db/repos.js';
import { ApprovalGate } from '../../src/gate/approval-gate.js';
import { ClickPresence } from '../../src/gate/presence.js';
import { RouteRegistry, type AnyRoute } from '../../src/routes/registry.js';
import { DraftsService, lintDraftFor } from '../../src/services/drafts.js';
import { PublishService, type PublishGate } from '../../src/services/publish.js';
import { RecoveryService } from '../../src/services/recovery.js';
import { computeT0 } from '../../src/t0.js';
import { FakeNotifier } from './fake-notifier.js';
import { FakePresence } from './fake-presence.js';
import { FakeRoute } from './fake-route.js';

const FIXTURES = fileURLToPath(new URL('../../../core/test/fixtures/', import.meta.url));

export const SLUG = 'prometheus-cardinality-explained';
/** Install day: the first time this tool saw the (3-month-old) fixture post live. */
export const LIVE = '2026-10-19T08:00:00.000Z';
export const START = '2026-10-19T10:00:00.000Z';

export function loadItem(): ContentItem {
  return buildContentItem({
    slug: SLUG,
    mdxRaw: readFileSync(`${FIXTURES}sample-post.mdx`, 'utf8'),
    notesRaw: readFileSync(`${FIXTURES}sample-notes.md`, 'utf8'),
    repoCommit: 'abc1234',
    dirty: false,
    baseUrl: DEFAULT_BASE_URL,
  });
}

/** A LinkedIn post that passes lint: one UTM link, a full takeaway, no unsourced numbers. */
export function goodLinkedinText(item: ContentItem): string {
  return [
    'Prometheus cost follows series count, not the number of labels you add to a metric.',
    'Every new label value makes a new series in the head block, and each series carries its own index entry, chunks and WAL records.',
    'So the fix is rarely fewer labels. It is fewer distinct values per label, above all on high-churn dimensions like pod names and request ids.',
    'Aggregate early, drop what nobody queries, and watch head series before it watches you.',
    '',
    withUtm(item.canonicalUrl, 'linkedin', item.slug),
  ].join('\n');
}

export interface RigOptions {
  /** `platforms.linkedin.route`. Default 'buffer'. */
  linkedinRoute?: 'buffer' | 'assist';
  /** Seed the content row as live (with t0). Default true. */
  live?: boolean;
  /** Replacement routes, built over the rig's repos; default fake dev.to, Buffer and assist routes. */
  routes?: (repos: Repos) => AnyRoute[];
  /** Wraps the real gate (to inject a change between authorize and the send). */
  wrapGate?: (gate: ApprovalGate) => PublishGate;
}

export interface Rig {
  db: Db;
  repos: Repos;
  audit: Audit;
  clock: { now: Date };
  config: Config;
  item: ContentItem;
  presence: FakePresence;
  notifier: FakeNotifier;
  gate: ApprovalGate;
  /** The chat approval path's gate: same repos and checks, presence always 'verified' (the prompt in Claude Code). */
  chatGate: ApprovalGate;
  routes: RouteRegistry;
  devto: FakeRoute;
  buffer: FakeRoute;
  assist: FakeRoute;
  drafts: DraftsService;
  publish: PublishService;
  recovery: RecoveryService;
  /** request + approve with every box ticked and Hello verified; returns the approval id. */
  approve(draftId: string, mode?: ApprovalMode): Promise<string>;
  /** Audit actions for one draft, oldest first. */
  actions(draftId: string): string[];
}

export function makeRig(options: RigOptions = {}): Rig {
  const clock = { now: new Date(START) };
  const db = openDb(':memory:');
  const repos = createRepos(db, { now: () => clock.now.toISOString() });
  repos.settings.set('publishing_enabled', 'true');
  const config = ConfigSchema.parse({ platforms: { linkedin: { route: options.linkedinRoute ?? 'buffer' } } });
  const item = loadItem();

  repos.content.upsert({
    slug: SLUG,
    canonicalUrl: item.canonicalUrl,
    title: item.frontmatter.title,
    date: item.frontmatter.date,
    mdxSha256: item.source.mdxSha256,
    ...(item.source.notesSha256 === undefined ? {} : { notesSha256: item.source.notesSha256 }),
    repoCommit: 'abc1234',
    dirty: false,
    published: true,
    ...(options.live === false ? {} : { canonicalLiveAt: LIVE, t0: computeT0(item.frontmatter.date, LIVE, 'UTC') as string }),
  });

  const presence = new FakePresence('verified');
  const notifier = new FakeNotifier();
  const devto = new FakeRoute('devto', 'direct', { stage: true, checkOnPlatform: true });
  const buffer = new FakeRoute('linkedin', 'buffer', { stage: true, checkOnPlatform: true, cancelScheduled: true });
  const assist = new FakeRoute('linkedin', 'assist', { handOff: true });
  const routes = new RouteRegistry(options.routes?.(repos) ?? [devto, buffer, assist]);
  const loadContentItem = (slug: string): ContentItem | undefined => (slug === SLUG ? item : undefined);
  const audit = createAudit(repos);

  const gate = new ApprovalGate({
    repos,
    now: () => clock.now,
    health: () => Promise.resolve(true),
    presence,
    loadContentItem,
    lintDraft: lintDraftFor(config),
  });
  const chatGate = new ApprovalGate({
    repos,
    now: () => clock.now,
    health: () => Promise.resolve(true),
    presence: new ClickPresence(),
    loadContentItem,
    lintDraft: lintDraftFor(config),
  });
  let n = 0;
  const newId = (): string => `id-${++n}`;
  const drafts = new DraftsService({ repos, routes, config: () => config, loadContentItem, audit, notifier, newId });
  const publish = new PublishService({
    repos,
    gate: options.wrapGate?.(gate) ?? gate,
    routes,
    config: () => config,
    audit,
    notifier,
    now: () => clock.now,
    newId,
  });
  const recovery = new RecoveryService({ repos, routes, audit, notifier, now: () => clock.now, newId });

  return {
    db,
    repos,
    audit,
    clock,
    config,
    item,
    presence,
    notifier,
    gate,
    chatGate,
    routes,
    devto,
    buffer,
    assist,
    drafts,
    publish,
    recovery,
    async approve(draftId, mode = 'approve_only') {
      const { approvalId } = gate.request(draftId);
      await gate.approve(approvalId, { channel: 'dashboard_hello', checked: gate.checklist(draftId), mode });
      return approvalId;
    },
    actions(draftId) {
      return repos.audit
        .list({ draftId, limit: 1000 })
        .reverse()
        .map((row) => row.action);
    },
  };
}

import { sql } from 'drizzle-orm';
import { AGENT_SCOPES } from '../../lib/agent';
import { PROTOCOLS, PROVIDER_KINDS, TASK_KINDS, TASK_STATUSES, TRUST_LEVELS } from '../../lib/ai';
import type { TaskResult } from '../../lib/ai-ops';
import { ARTICLE_SOURCE_KINDS, ARTICLE_STATUSES, VERSION_REASONS } from '../../lib/articles';
import {
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  ATTEMPT_KINDS,
  ATTEMPT_STATUSES,
  CONNECTION_STATUSES,
  DRAFT_STATUSES,
  ERROR_KINDS,
  PLATFORM_IDS,
  PUBLISHED_VIA,
  type ConnectionConfig,
  type DraftExtras,
  type DraftPayload,
  type LintIssue,
  type RemoteInfo,
  type TagReport,
} from '../../lib/publishing';
import { CONNECTOR_IDS } from '../../lib/connectors/ids';
import { SITE_PRESETS, type SiteMapping } from '../../lib/site-export';
import {
  CONFIDENCE_LEVELS,
  CONFIDENTIALITY_LEVELS,
  ITEM_KINDS,
  SOURCE_KINDS,
  VERIFICATION_STATUSES,
} from '../../lib/knowledge';
import { type AnyPgColumn, boolean, customType, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Tenant model: `users.id` is the owner id. Every other table carries `owner_id`
 * referencing it, and is only read or written through src/server/data (scoped by owner).
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 'local_owner' is the single implicit account in local mode; 'member' is a hosted account. */
  kind: text('kind', { enum: ['local_owner', 'member'] }).notNull().default('member'),
  /** Marks the designated owner in local mode. Hosted mode designates the owner with OWNER_USER_ID. */
  isOwner: boolean('is_owner').notNull().default(false),
  email: text('email').unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  displayName: text('display_name').notNull(),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/*
 * Sign-in tables (hosted mode), shaped for Better Auth. They hold credentials and sessions, not
 * tenant content, and are touched only by the auth module (src/server/auth), never by app code.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sessions_user_idx').on(table.userId)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    /** Salted scrypt hash for the 'credential' provider. Never a plain password. */
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('accounts_user_idx').on(table.userId)],
);

export const verifications = pgTable(
  'verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Who caused it: the signed-in person, the system, an MCP client or an AI provider. */
    actor: text('actor', { enum: ['owner', 'system', 'agent', 'ai'] }).notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_events_owner_created_idx').on(table.ownerId, table.createdAt)],
);

export type User = typeof users.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

const textArray = (name: string) => text(name).array().notNull().default(sql`'{}'::text[]`);

/*
 * Personal knowledge. Every table below carries owner_id and is read or written only through
 * src/server/data (forOwner), which filters by it. A source-rule test fails the build otherwise.
 */

/** One profile per owner. */
export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    headline: text('headline'),
    yearsExperience: integer('years_experience'),
    location: text('location'),
    careerGoals: text('career_goals'),
    targetEmployers: textArray('target_employers'),
    expertiseAreas: textArray('expertise_areas'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('profiles_owner_idx').on(table.ownerId)],
);

/** One set of brand preferences per owner. */
export const brandPreferences = pgTable(
  'brand_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tone: text('tone'),
    audience: text('audience'),
    writingStyle: text('writing_style'),
    avoid: textArray('avoid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('brand_preferences_owner_idx').on(table.ownerId)],
);

/** Where knowledge came from: a page, a document, a repository, or the owner typing it in. */
export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Stable key for idempotent seeding. Null for anything a person adds by hand. */
    seedKey: text('seed_key'),
    kind: text('kind', { enum: SOURCE_KINDS }).notNull().default('manual'),
    title: text('title').notNull(),
    uri: text('uri'),
    sourceDate: date('source_date', { mode: 'string' }),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('knowledge_sources_owner_imported_idx').on(table.ownerId, table.importedAt),
    uniqueIndex('knowledge_sources_owner_seed_idx').on(table.ownerId, table.seedKey),
  ],
);

/**
 * A single claim, experience or note, kept separate from every other. Defaults are the safe ones:
 * private, unverified, and not permitted for public use until the owner says so.
 */
export const knowledgeItems = pgTable(
  'knowledge_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => knowledgeSources.id, { onDelete: 'set null' }),
    /** Stable key for idempotent seeding. Null for anything a person adds by hand. */
    seedKey: text('seed_key'),
    kind: text('kind', { enum: ITEM_KINDS }).notNull().default('note'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    tags: textArray('tags'),
    sourceDate: date('source_date', { mode: 'string' }),
    verificationStatus: text('verification_status', { enum: VERIFICATION_STATUSES }).notNull().default('unverified'),
    confidence: text('confidence', { enum: CONFIDENCE_LEVELS }).notNull().default('medium'),
    confidentiality: text('confidentiality', { enum: CONFIDENTIALITY_LEVELS }).notNull().default('private'),
    publicUsePermitted: boolean('public_use_permitted').notNull().default(false),
    lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Ranked full-text index: title (A), body (B), tags (C). Maintained by Postgres. */
    search: tsvector('search').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'B') || setweight(to_tsvector('english', coalesce(cph_join_tags(tags), '')), 'C')`,
    ),
  },
  (table) => [
    index('knowledge_items_owner_updated_idx').on(table.ownerId, table.updatedAt),
    index('knowledge_items_owner_status_idx').on(table.ownerId, table.verificationStatus),
    index('knowledge_items_search_idx').using('gin', table.search),
    uniqueIndex('knowledge_items_owner_seed_idx').on(table.ownerId, table.seedKey),
  ],
);

export type Profile = typeof profiles.$inferSelect;
export type BrandPreferences = typeof brandPreferences.$inferSelect;
export type KnowledgeSource = typeof knowledgeSources.$inferSelect;
export type KnowledgeItem = Omit<typeof knowledgeItems.$inferSelect, 'search'>;

export {
  CONFIDENCE_LEVELS,
  CONFIDENTIALITY_LEVELS,
  ITEM_KINDS,
  SOURCE_KINDS,
  VERIFICATION_STATUSES,
} from '../../lib/knowledge';
export type {
  Confidence,
  Confidentiality,
  ItemKind,
  SourceKind,
  VerificationStatus,
} from '../../lib/knowledge';

/*
 * Article studio (Day 3). Every table below carries owner_id and is read or written only through
 * src/server/data (forOwner). Article ids and slugs are never trusted across owners: a slug is unique
 * per owner, so two owners may both have "hello-world".
 */

/** An article and its current content. The history of earlier content is in `articleVersions`. */
export const articles = pgTable(
  'articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    tags: textArray('tags'),
    canonicalUrl: text('canonical_url'),
    coverAssetId: uuid('cover_asset_id').references((): AnyPgColumn => assets.id, { onDelete: 'set null' }),
    status: text('status', { enum: ARTICLE_STATUSES }).notNull().default('draft'),
    bodyMarkdown: text('body_markdown').notNull().default(''),
    sourceKind: text('source_kind', { enum: ARTICLE_SOURCE_KINDS }).notNull().default('manual'),
    /** The file name, relative folder path or URL the article was imported from. */
    sourceRef: text('source_ref'),
    /** Front matter keys with no home of their own (author, series, and so on), kept as imported. */
    extraMetadata: jsonb('extra_metadata').$type<Record<string, unknown>>().notNull().default({}),
    /** Optimistic concurrency token: every accepted save increments it. A save must name the one it saw. */
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set by publishing (Day 5). Nothing writes it yet. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** Ranked full-text index: title (A), description and tags (B), body (C). Maintained by Postgres. */
    search: tsvector('search').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B') || setweight(to_tsvector('english', coalesce(cph_join_tags(tags), '')), 'B') || setweight(to_tsvector('english', coalesce(body_markdown, '')), 'C')`,
    ),
  },
  (table) => [
    uniqueIndex('articles_owner_slug_idx').on(table.ownerId, table.slug),
    index('articles_owner_updated_idx').on(table.ownerId, table.updatedAt),
    index('articles_owner_status_idx').on(table.ownerId, table.status),
    index('articles_search_idx').using('gin', table.search),
  ],
);

/** Immutable snapshots of an article's content. Rows are only ever inserted, never changed. */
export const articleVersions = pgTable(
  'article_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Slug, description, tags, canonical URL, cover and status as they were. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    reason: text('reason', { enum: VERSION_REASONS }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('article_versions_article_no_idx').on(table.articleId, table.versionNo),
    index('article_versions_owner_article_idx').on(table.ownerId, table.articleId),
  ],
);

/** An uploaded file (an image today). The bytes live in the storage adapter under `storageKey`. */
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The article it was first uploaded for. Cleared if that article is deleted; the file stays. */
    articleId: uuid('article_id').references((): AnyPgColumn => articles.id, { onDelete: 'set null' }),
    filename: text('filename').notNull(),
    /** Decided by sniffing the bytes, never taken from the upload. */
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    /** Generated by the server. Never derived from the file name. */
    storageKey: text('storage_key').notNull(),
    alt: text('alt').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('assets_owner_sha_idx').on(table.ownerId, table.sha256),
    index('assets_owner_article_idx').on(table.ownerId, table.articleId),
  ],
);

/** Studio settings, one row per owner. Today: the folder of Markdown files the owner imports from. */
export const studioSettings = pgTable(
  'studio_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    contentFolder: text('content_folder'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('studio_settings_owner_idx').on(table.ownerId)],
);

/*
 * Agent access (Day 4). A credential belongs to one owner and is the only thing the agent API uses to
 * decide whose data a request touches. Only a SHA-256 hash of the secret is stored; the secret itself
 * is shown once, when it is created.
 */
export const agentCredentials = pgTable(
  'agent_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First characters of the secret, for display only. */
    prefix: text('prefix').notNull(),
    /** Hex SHA-256 of the whole secret. The secret is 256 random bits, so a fast hash is enough. */
    secretHash: text('secret_hash').notNull(),
    scopes: text('scopes', { enum: AGENT_SCOPES }).array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('agent_credentials_hash_idx').on(table.secretHash),
    index('agent_credentials_owner_idx').on(table.ownerId, table.createdAt),
  ],
);

export type AgentCredential = typeof agentCredentials.$inferSelect;

/**
 * AI providers (Day 4), per owner. The API key, when there is one, is stored only as AES-256-GCM
 * ciphertext bound to this row (see src/server/ai/crypto.ts) and is never sent to the browser.
 */
export const aiProviders = pgTable(
  'ai_providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind', { enum: PROVIDER_KINDS }).notNull(),
    protocol: text('protocol', { enum: PROTOCOLS }),
    baseUrl: text('base_url'),
    model: text('model'),
    /** Where the text goes. Derived by the server from the kind and address, never typed by the person. */
    trust: text('trust', { enum: TRUST_LEVELS }).notNull().default('external'),
    encryptedKey: text('encrypted_key'),
    keyLast4: text('key_last4'),
    workspaceId: text('workspace_id'),
    monthlyTokenCap: integer('monthly_token_cap'),
    isDefault: boolean('is_default').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    lastTestAt: timestamp('last_test_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    lastTestMessage: text('last_test_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ai_providers_owner_idx').on(table.ownerId, table.createdAt)],
);

export type AiProvider = typeof aiProviders.$inferSelect;

/**
 * The AI task inbox (Day 4). One row per request for help with an article: what was asked, what text it
 * covers, who runs it, and the structured result waiting for the person's decision. Nothing here is ever
 * applied to an article automatically.
 */
export const aiTasks = pgTable(
  'ai_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: TASK_KINDS }).notNull(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    /** The selected range in the article body when the task was made. Null for a task on the article as a whole. */
    selStart: integer('sel_start'),
    selEnd: integer('sel_end'),
    /** The exact text the task covers, copied from the article when it was made. */
    excerpt: text('excerpt').notNull(),
    instruction: text('instruction').notNull().default(''),
    /** Null once the provider has been deleted; the snapshot below still says who it was. */
    providerId: uuid('provider_id').references(() => aiProviders.id, { onDelete: 'set null' }),
    providerKind: text('provider_kind', { enum: PROVIDER_KINDS }),
    providerName: text('provider_name'),
    model: text('model'),
    status: text('status', { enum: TASK_STATUSES }).notNull().default('pending'),
    result: jsonb('result').$type<TaskResult>(),
    error: text('error'),
    /** The article revision the task was made against. */
    articleRevision: integer('article_revision').notNull(),
    /** The exact text a provider receives (or Claude Code reads). Also what a per-task approval showed. */
    promptText: text('prompt_text'),
    promptSha256: text('prompt_sha256'),
    /** Identical requests share this hash, so a repeat is answered from an earlier result instead of paying again. */
    requestHash: text('request_hash'),
    /** Private knowledge items the person approved sending for this task. */
    approvedItemIds: text('approved_item_ids').array().notNull().default(sql`'{}'::text[]`),
    /** The notes that went into the context, for display: id, title, text, and whether an approval let them in. */
    contextNotes: jsonb('context_notes').$type<{ id: string; title: string; body: string; viaApproval: boolean }[]>().notNull().default([]),
    withheldCount: integer('withheld_count').notNull().default(0),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    /** True when any token count is our estimate (characters / 4) rather than the provider's own number. */
    tokensEstimated: boolean('tokens_estimated').notNull().default(true),
    fromCache: boolean('from_cache').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    /** Set for a task made for one destination in the composer; the result is a proposal for that draft. */
    draftId: uuid('draft_id').references((): AnyPgColumn => platformDrafts.id, { onDelete: 'set null' }),
    /** The draft's payload hash when the task was made. A proposal for a draft that has changed since is stale. */
    draftHash: text('draft_hash'),
    platform: text('platform', { enum: PLATFORM_IDS }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('ai_tasks_owner_article_idx').on(table.ownerId, table.articleId, table.createdAt),
    index('ai_tasks_owner_status_idx').on(table.ownerId, table.status),
    index('ai_tasks_owner_hash_idx').on(table.ownerId, table.requestHash),
  ],
);

export type AiTask = typeof aiTasks.$inferSelect;
export type Article = Omit<typeof articles.$inferSelect, 'search'>;
export type ArticleVersion = typeof articleVersions.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type StudioSettings = typeof studioSettings.$inferSelect;

/*
 * Publishing (Day 5). Every table carries owner_id and is reached only through the data layer.
 */

/**
 * A person's connection to one platform. The key is stored only as AES-256-GCM ciphertext bound to
 * this row (see src/server/ai/crypto.ts) and is never sent to the browser, the agent API or MCP.
 */
export const platformConnections = pgTable(
  'platform_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Any directory entry that can be connected (see lib/connectors). The three with a publishing adapter keep a raw key. */
    platform: text('platform', { enum: CONNECTOR_IDS }).notNull(),
    encryptedKey: text('encrypted_key').notNull(),
    keyLast4: text('key_last4').notNull(),
    status: text('status', { enum: CONNECTION_STATUSES }).notNull().default('unchecked'),
    /** Who the platform says the key belongs to, from the last read-only probe. */
    who: text('who'),
    /** Non-secret settings found by the probe (the Hashnode publication). */
    config: jsonb('config').$type<ConnectionConfig>().notNull().default({}),
    /** The last time a read-only check ran (success or not). */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastCheckMessage: text('last_check_message'),
    /** How it was connected: a key, a sign-in, a device code... (see AUTH_KINDS). Null on rows made before the connector framework. */
    authKind: text('auth_kind'),
    /** The scopes the platform said it granted. Names only. */
    scopesGranted: text('scopes_granted').array().notNull().default(sql`'{}'::text[]`),
    /** When the access token stops working, if the platform says. */
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    /** A refresh token is held (inside the encrypted bundle), so an expired access token is renewed rather than lost. */
    renewable: boolean('renewable').notNull().default(false),
    /** A short code for the last failed check: rejected, expired, unreachable, rate_limited... Never a message with a secret. */
    lastErrorCode: text('last_error_code'),
    /** Counts every token renewal. A renewal only wins if it saw the generation it started from. */
    refreshGeneration: integer('refresh_generation').notNull().default(0),
    /** A renewal in progress holds this lease, so two requests cannot both use a single-use refresh token. */
    refreshLockUntil: timestamp('refresh_lock_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('platform_connections_owner_platform_idx').on(table.ownerId, table.platform)],
);

export type PlatformConnection = typeof platformConnections.$inferSelect;

/**
 * An article adapted for one platform, with the exact payload and its hash. The unique partial index is
 * the last line of defense against a double publish: no two drafts of one owner can be publishing,
 * unknown or published with the same payload hash on the same platform.
 */
export const platformDrafts = pgTable(
  'platform_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: PLATFORM_IDS }).notNull(),
    connectionId: uuid('connection_id').references(() => platformConnections.id, { onDelete: 'set null' }),
    /** Who the connection was when the draft was built, so the approval names the account. */
    account: text('account'),
    status: text('status', { enum: DRAFT_STATUSES }).notNull().default('draft'),
    payload: jsonb('payload').$type<DraftPayload>().notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    tagReport: jsonb('tag_report').$type<TagReport>().notNull(),
    lint: jsonb('lint').$type<LintIssue[]>().notNull().default([]),
    /** The article revision and a hash of the fields the payload was built from. */
    sourceRevision: integer('source_revision').notNull(),
    sourceHash: text('source_hash').notNull(),
    stale: boolean('stale').notNull().default(false),
    remoteId: text('remote_id'),
    remoteUrl: text('remote_url'),
    remotePreviewUrl: text('remote_preview_url'),
    failureKind: text('failure_kind', { enum: ERROR_KINDS }),
    failureMessage: text('failure_message'),
    nextAction: text('next_action'),
    stagedAt: timestamp('staged_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** What the adapter produced from the article. Edits change `payload`; this stays, so "reset to generated" and the diff work. */
    generatedPayload: jsonb('generated_payload').$type<DraftPayload>().notNull().default(sql`'{}'::jsonb`),
    /** Options bound to the payload (the personal site's path and mapping). Hashed together with it. */
    extras: jsonb('extras').$type<DraftExtras>().notNull().default({}),
    /** What the last read-only look at the target found. Not hashed. */
    remoteInfo: jsonb('remote_info').$type<RemoteInfo>(),
    publishedVia: text('published_via', { enum: PUBLISHED_VIA }),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    editCount: integer('edit_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('platform_drafts_owner_article_idx').on(table.ownerId, table.articleId, table.platform),
    index('platform_drafts_owner_status_idx').on(table.ownerId, table.status),
    uniqueIndex('platform_drafts_out_once_idx')
      .on(table.ownerId, table.platform, table.payloadSha256)
      .where(sql`${table.status} in ('publishing', 'unknown', 'published')`),
  ],
);

export type PlatformDraft = typeof platformDrafts.$inferSelect;

/**
 * A request for the owner's approval of one payload. Single use: it becomes `used` in the same
 * transaction that moves the draft to `publishing`. It dies when the payload or the article changes.
 */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => platformDrafts.id, { onDelete: 'cascade' }),
    payloadSha256: text('payload_sha256').notNull(),
    tag: text('tag').notNull(),
    status: text('status', { enum: APPROVAL_STATUSES }).notNull().default('pending'),
    requestedBy: text('requested_by', { enum: ['owner', 'agent'] }).notNull().default('owner'),
    /** `publish` sends the payload; `manual` records a post the owner made by hand. */
    kind: text('kind', { enum: APPROVAL_KINDS }).notNull().default('publish'),
    /** The checklist boxes ticked on the card, verbatim. Empty until the approval is used. */
    checked: text('checked').array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    usedAt: timestamp('used_at', { withTimezone: true }),
    invalidReason: text('invalid_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('approvals_owner_draft_idx').on(table.ownerId, table.draftId, table.createdAt)],
);

export type Approval = typeof approvals.$inferSelect;

/** One row per call that can change or read a platform: stage, publish, check, and manual resolutions. */
export const publishAttempts = pgTable(
  'publish_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => platformDrafts.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ATTEMPT_KINDS }).notNull(),
    status: text('status', { enum: ATTEMPT_STATUSES }).notNull().default('started'),
    payloadSha256: text('payload_sha256').notNull(),
    approvalId: uuid('approval_id').references(() => approvals.id, { onDelete: 'set null' }),
    httpStatus: integer('http_status'),
    errorKind: text('error_kind', { enum: ERROR_KINDS }),
    /** Redacted, user-readable. */
    message: text('message'),
    remoteId: text('remote_id'),
    remoteUrl: text('remote_url'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('publish_attempts_owner_draft_idx').on(table.ownerId, table.draftId, table.startedAt)],
);

export type PublishAttempt = typeof publishAttempts.$inferSelect;

/*
 * The composer (Day 6).
 */

/** A destination the owner added to an article. A draft may or may not exist yet ("not prepared"). */
export const articleDestinations = pgTable(
  'article_destinations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: PLATFORM_IDS }).notNull(),
    /** The order the owner chose; the review queue follows it. */
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('article_destinations_article_platform_idx').on(table.ownerId, table.articleId, table.platform)],
);

export type ArticleDestination = typeof articleDestinations.$inferSelect;

/**
 * The personal site: where it lives, which repository a pull request goes to and how a file is laid out. One row
 * per owner. The GitHub token is not here: it is a `platform_connections` row, encrypted like every other key.
 */
export const siteSettings = pgTable(
  'site_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The site's public address. The canonical page must be on this host. */
    siteUrl: text('site_url'),
    /** "owner/name" of the one repository a pull request is opened on. */
    repo: text('repo'),
    baseBranch: text('base_branch').notNull().default('main'),
    pathTemplate: text('path_template').notNull().default('content/posts/{slug}.md'),
    preset: text('preset', { enum: SITE_PRESETS }).notNull().default('generic'),
    mapping: jsonb('mapping').$type<SiteMapping>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('site_settings_owner_idx').on(table.ownerId)],
);

export type SiteSettings = typeof siteSettings.$inferSelect;

/** The result of looking at an article's canonical page, kept so the approval checklist can depend on it. */
export const canonicalChecks = pgTable(
  'canonical_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    state: text('state', { enum: ['live', 'not_live', 'unreachable', 'blocked'] }).notNull(),
    httpStatus: integer('http_status'),
    title: text('title'),
    finalUrl: text('final_url'),
    message: text('message').notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('canonical_checks_article_url_idx').on(table.ownerId, table.articleId, table.url)],
);

export type CanonicalCheck = typeof canonicalChecks.$inferSelect;

/**
 * Credentials the owner saved for integrations that are not built yet (an OAuth client id and secret, a key for a
 * platform whose adapter arrives later). AES-256-GCM ciphertext bound to the owner and this row, exactly like the
 * platform and AI provider keys. They are labelled "Saved. Not used yet." and are never sent to the browser, the
 * agent API, MCP, logs or exports. `hint` is the last four characters of the key or client id, for display only.
 */
export const integrationSecrets = pgTable(
  'integration_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** An id from the platform directory. */
    platform: text('platform').notNull(),
    kind: text('kind', { enum: ['api_key', 'oauth_client', 'device_client'] }).notNull(),
    encrypted: text('encrypted').notNull(),
    hint: text('hint').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('integration_secrets_owner_platform_kind_idx').on(table.ownerId, table.platform, table.kind)],
);

export type IntegrationSecret = typeof integrationSecrets.$inferSelect;

/**
 * A sign-in in progress: an OAuth redirect waiting for its callback, or a device code waiting for the person to enter
 * it. The state is kept only as a SHA-256 hash and is bound to the session that started it, single use and short lived.
 * The PKCE verifier and the device code are AES-256-GCM ciphertext bound to this row, like every other secret.
 */
export const connectFlows = pgTable(
  'connect_flows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: CONNECTOR_IDS }).notNull(),
    kind: text('kind', { enum: ['oauth', 'device'] }).notNull(),
    /** SHA-256 of the state value sent to the platform. Null for a device flow. */
    stateHash: text('state_hash'),
    /** SHA-256 of the session id that started the flow. A callback from any other session is refused. */
    sessionHash: text('session_hash').notNull(),
    redirectUri: text('redirect_uri'),
    codeVerifierEnc: text('code_verifier_enc'),
    deviceCodeEnc: text('device_code_enc'),
    userCode: text('user_code'),
    verificationUri: text('verification_uri'),
    intervalSec: integer('interval_sec'),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    /** The person's own server for a per-instance platform (Mastodon). */
    instance: text('instance'),
    status: text('status', { enum: ['pending', 'used', 'cancelled', 'expired', 'failed'] })
      .notNull()
      .default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [
    index('connect_flows_owner_status_idx').on(table.ownerId, table.status, table.expiresAt),
    uniqueIndex('connect_flows_owner_state_idx').on(table.ownerId, table.stateHash).where(sql`${table.stateHash} is not null`),
  ],
);

export type ConnectFlow = typeof connectFlows.$inferSelect;

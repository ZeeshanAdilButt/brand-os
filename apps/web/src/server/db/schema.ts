import { sql } from 'drizzle-orm';
import { AGENT_SCOPES } from '../../lib/agent';
import { PROTOCOLS, PROVIDER_KINDS, TRUST_LEVELS } from '../../lib/ai';
import { ARTICLE_SOURCE_KINDS, ARTICLE_STATUSES, VERSION_REASONS } from '../../lib/articles';
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
export type Article = Omit<typeof articles.$inferSelect, 'search'>;
export type ArticleVersion = typeof articleVersions.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type StudioSettings = typeof studioSettings.$inferSelect;

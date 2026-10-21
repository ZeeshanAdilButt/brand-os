import { z } from 'zod';
import type { AppConfig } from '../config';
import type { AppDb } from '../db/client';
import { CONFIDENCE_LEVELS, ITEM_KINDS, SOURCE_KINDS, VERIFICATION_STATUSES } from '../db/schema';
import { forOwner } from './tenant';
import { findUser, LOCAL_OWNER_ID } from './users';

/**
 * The private owner seed: personal context that belongs to one designated user and must never
 * enter git. This module holds the schema and the logic only; the data comes from the gitignored
 * file apps/web/seed/owner.private.json, read by scripts/seed-owner.ts. Nothing here (or in any
 * test) contains real seed content.
 */

const seedKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,80}$/, 'seed keys are lowercase letters, digits, dot, dash, underscore');
const optionalText = z.string().trim().min(1).nullable().default(null);
const textList = z.array(z.string().trim().min(1)).default([]);

const seedSource = z
  .object({
    seedKey,
    kind: z.enum(SOURCE_KINDS).default('owner_provided'),
    title: z.string().trim().min(1),
    uri: optionalText,
    sourceDate: z.iso.date().nullable().default(null),
  })
  .strict();

// No publicUsePermitted and no confidentiality above internal: a seed can never make anything public.
const seedItem = z
  .object({
    seedKey,
    kind: z.enum(ITEM_KINDS),
    title: z.string().trim().min(1),
    body: z.string().trim().default(''),
    tags: textList,
    sourceKey: seedKey.nullable().default(null),
    sourceDate: z.iso.date().nullable().default(null),
    verificationStatus: z.enum(VERIFICATION_STATUSES).default('owner_claim_needs_review'),
    confidence: z.enum(CONFIDENCE_LEVELS).default('medium'),
    confidentiality: z.enum(['private', 'internal']).default('private'),
  })
  .strict();

export const ownerSeedSchema = z
  .object({
    version: z.literal(1),
    profile: z
      .object({
        name: z.string().trim().min(1),
        headline: optionalText,
        yearsExperience: z.number().int().min(0).max(80).nullable().default(null),
        location: optionalText,
        careerGoals: optionalText,
        targetEmployers: textList,
        expertiseAreas: textList,
      })
      .strict(),
    preferences: z
      .object({ tone: optionalText, audience: optionalText, writingStyle: optionalText, avoid: textList })
      .strict(),
    sources: z.array(seedSource).default([]),
    items: z.array(seedItem).default([]),
  })
  .strict()
  .superRefine((seed, ctx) => {
    const sourceKeys = new Set(seed.sources.map((s) => s.seedKey));
    if (sourceKeys.size !== seed.sources.length) ctx.addIssue({ code: 'custom', message: 'duplicate source seed key', path: ['sources'] });
    const itemKeys = new Set(seed.items.map((i) => i.seedKey));
    if (itemKeys.size !== seed.items.length) ctx.addIssue({ code: 'custom', message: 'duplicate item seed key', path: ['items'] });
    seed.items.forEach((item, index) => {
      if (item.sourceKey && !sourceKeys.has(item.sourceKey)) {
        ctx.addIssue({ code: 'custom', message: 'item refers to an unknown source key', path: ['items', index, 'sourceKey'] });
      }
    });
  });

export type OwnerSeed = z.infer<typeof ownerSeedSchema>;

export class SeedRefusedError extends Error {
  constructor(reason: string) {
    super(`Owner seed refused: ${reason}`);
    this.name = 'SeedRefusedError';
  }
}

/**
 * Who the seed may write to. Local mode: the auto-provisioned owner row, and only if it carries
 * the owner flag. Hosted mode: the user id in OWNER_USER_ID. Never a name, email or display name.
 */
export async function resolveDesignatedOwnerId(config: AppConfig, db: AppDb): Promise<string | undefined> {
  if (config.mode === 'hosted') return config.ownerUserId;
  const owner = await findUser(db, LOCAL_OWNER_ID);
  return owner?.isOwner ? owner.id : undefined;
}

export interface SeedCounts {
  profile: 'created' | 'kept';
  preferences: 'created' | 'kept';
  sources: { created: number; kept: number };
  items: { created: number; kept: number };
}

/**
 * Apply the seed to `targetUserId`, but only if that id is the designated owner. Idempotent: each
 * item is keyed by its seed_key and inserted only when absent, so a re-run changes nothing and
 * edits the owner has made since are never overwritten. All-or-nothing: one transaction.
 */
export async function applyOwnerSeed(
  db: AppDb,
  input: { targetUserId: string; designatedOwnerId: string | undefined; seed: OwnerSeed },
): Promise<SeedCounts> {
  const { targetUserId, designatedOwnerId } = input;
  if (!designatedOwnerId) {
    throw new SeedRefusedError('no owner is designated (local mode needs the owner row; hosted mode needs OWNER_USER_ID).');
  }
  if (targetUserId.toLowerCase() !== designatedOwnerId.toLowerCase()) {
    throw new SeedRefusedError('the target user is not the designated owner.');
  }
  const user = await findUser(db, designatedOwnerId);
  if (!user) throw new SeedRefusedError('the designated owner has no account yet.');
  if (user.kind === 'local_owner' && !user.isOwner) throw new SeedRefusedError('the local account is not marked as owner.');

  const seed = ownerSeedSchema.parse(input.seed);

  return db.transaction(async (tx) => {
    const data = forOwner(user.id, tx as unknown as AppDb);
    const counts: SeedCounts = {
      profile: 'kept',
      preferences: 'kept',
      sources: { created: 0, kept: 0 },
      items: { created: 0, kept: 0 },
    };
    counts.profile = await data.profile.insertIfMissing(seed.profile);
    counts.preferences = await data.preferences.insertIfMissing(seed.preferences);

    const sourceIds = new Map<string, string>();
    for (const source of seed.sources) {
      const result = await data.sources.insertSeeded(source.seedKey, {
        kind: source.kind,
        title: source.title,
        uri: source.uri,
        sourceDate: source.sourceDate,
      });
      sourceIds.set(source.seedKey, result.id);
      counts.sources[result.outcome] += 1;
    }

    for (const item of seed.items) {
      const outcome = await data.items.insertSeeded(item.seedKey, {
        kind: item.kind,
        title: item.title,
        body: item.body,
        tags: item.tags,
        sourceId: item.sourceKey ? (sourceIds.get(item.sourceKey) ?? null) : null,
        sourceDate: item.sourceDate,
        verificationStatus: item.verificationStatus,
        confidence: item.confidence,
        confidentiality: item.confidentiality,
        publicUsePermitted: false,
      });
      counts.items[outcome] += 1;
    }

    const changed = counts.sources.created + counts.items.created + (counts.profile === 'created' ? 1 : 0) + (counts.preferences === 'created' ? 1 : 0);
    if (changed > 0) {
      // Counts only: the audit trail never carries seed content.
      await data.audit.record({ actor: 'system', action: 'owner_seed.applied', entityType: 'user', entityId: user.id, metadata: { ...counts } });
    }
    return counts;
  });
}

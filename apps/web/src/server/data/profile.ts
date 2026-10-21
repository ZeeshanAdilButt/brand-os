import { eq } from 'drizzle-orm';
import { brandPreferences, profiles, type BrandPreferences, type Profile } from '../db/schema';
import type { Scope } from './scope';

export interface ProfileInput {
  name: string;
  headline: string | null;
  yearsExperience: number | null;
  location: string | null;
  careerGoals: string | null;
  targetEmployers: string[];
  expertiseAreas: string[];
}

export interface PreferencesInput {
  tone: string | null;
  audience: string | null;
  writingStyle: string | null;
  avoid: string[];
}

/** The one profile and the one set of brand preferences an owner has. */
export function scopedProfile(scope: Scope) {
  return {
    async get(): Promise<Profile | null> {
      const db = await scope.db();
      const [row] = await db.select().from(profiles).where(eq(profiles.ownerId, scope.ownerId));
      return row ?? null;
    },

    async upsert(input: ProfileInput): Promise<Profile> {
      const db = await scope.db();
      const values = {
        name: input.name,
        headline: input.headline,
        yearsExperience: input.yearsExperience,
        location: input.location,
        careerGoals: input.careerGoals,
        targetEmployers: input.targetEmployers,
        expertiseAreas: input.expertiseAreas,
      };
      const [row] = await db
        .insert(profiles)
        // ownerId is set last and from the scope: nothing in `input` can override it.
        .values({ ...values, ownerId: scope.ownerId })
        .onConflictDoUpdate({ target: profiles.ownerId, set: { ...values, updatedAt: new Date() } })
        .returning();
      if (!row) throw new Error('profile upsert returned no row');
      return row;
    },

    /** Insert only when the owner has no profile yet. Used by the seed so owner edits are never overwritten. */
    async insertIfMissing(input: ProfileInput): Promise<'created' | 'kept'> {
      const db = await scope.db();
      const rows = await db
        .insert(profiles)
        .values({ ...input, ownerId: scope.ownerId })
        .onConflictDoNothing()
        .returning({ id: profiles.id });
      return rows.length ? 'created' : 'kept';
    },
  };
}

export function scopedPreferences(scope: Scope) {
  return {
    async get(): Promise<BrandPreferences | null> {
      const db = await scope.db();
      const [row] = await db.select().from(brandPreferences).where(eq(brandPreferences.ownerId, scope.ownerId));
      return row ?? null;
    },

    async upsert(input: PreferencesInput): Promise<BrandPreferences> {
      const db = await scope.db();
      const values = { tone: input.tone, audience: input.audience, writingStyle: input.writingStyle, avoid: input.avoid };
      const [row] = await db
        .insert(brandPreferences)
        .values({ ...values, ownerId: scope.ownerId })
        .onConflictDoUpdate({ target: brandPreferences.ownerId, set: { ...values, updatedAt: new Date() } })
        .returning();
      if (!row) throw new Error('preferences upsert returned no row');
      return row;
    },

    async insertIfMissing(input: PreferencesInput): Promise<'created' | 'kept'> {
      const db = await scope.db();
      const rows = await db
        .insert(brandPreferences)
        .values({ ...input, ownerId: scope.ownerId })
        .onConflictDoNothing()
        .returning({ id: brandPreferences.id });
      return rows.length ? 'created' : 'kept';
    },
  };
}

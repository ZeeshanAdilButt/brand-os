import { z } from 'zod';
import type { BrandPreferences, Profile } from '../db/schema';
import { parseInput, type OwnerContext } from './owner';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));
const list = (maxItems: number, maxLength: number) => z.array(z.string().trim().min(1).max(maxLength)).max(maxItems).default([]);

export const profileInputSchema = z.object({
  name: z.string().trim().min(1, 'Your name is required.').max(120),
  headline: optionalText(200),
  yearsExperience: z
    .number({ error: 'Use a whole number of years.' })
    .int('Use a whole number of years.')
    .min(0)
    .max(80)
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  location: optionalText(120),
  careerGoals: optionalText(2000),
  targetEmployers: list(50, 80),
  expertiseAreas: list(50, 80),
});

export const preferencesInputSchema = z.object({
  tone: optionalText(500),
  audience: optionalText(500),
  writingStyle: optionalText(2000),
  avoid: list(50, 120),
});

export interface ProfileBundle {
  profile: Profile | null;
  preferences: BrandPreferences | null;
}

export async function getProfile(owner: OwnerContext): Promise<ProfileBundle> {
  const [profile, preferences] = await Promise.all([owner.data.profile.get(), owner.data.preferences.get()]);
  return { profile, preferences };
}

export async function saveProfile(owner: OwnerContext, input: unknown): Promise<Profile> {
  const values = parseInput(profileInputSchema, input);
  const profile = await owner.data.profile.upsert(values);
  await owner.data.audit.record({ actor: owner.actor, action: 'profile.saved', entityType: 'profile', entityId: profile.id });
  return profile;
}

export async function savePreferences(owner: OwnerContext, input: unknown): Promise<BrandPreferences> {
  const values = parseInput(preferencesInputSchema, input);
  const preferences = await owner.data.preferences.upsert(values);
  await owner.data.audit.record({ actor: owner.actor, action: 'preferences.saved', entityType: 'preferences', entityId: preferences.id });
  return preferences;
}

/** Where a new account stands: drives the onboarding checklist and the empty states. */
export async function onboardingState(owner: OwnerContext) {
  const [profile, counts] = await Promise.all([owner.data.profile.get(), owner.data.items.counts()]);
  return { hasProfile: profile !== null, items: counts.total, needsReview: counts.needsReview };
}

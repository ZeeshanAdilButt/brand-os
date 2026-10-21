'use server';

import { revalidatePath } from 'next/cache';
import { ActionError, sessionToOwner, splitList } from '@/server/actions/owner';
import { savePreferences, saveProfile } from '@/server/actions/profile';
import { requireSessionUser } from '@/server/auth/session';
import type { FormState } from './form-state';

const text = (data: FormData, key: string) => {
  const value = data.get(key);
  return typeof value === 'string' ? value : '';
};

function years(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  // Pass non-integers through so validation reports them instead of silently rounding.
  return Number.isFinite(n) ? n : Number.NaN;
}

function toErrorState(err: unknown): FormState {
  if (err instanceof ActionError) return { status: 'error', message: err.message, fields: err.fields };
  throw err;
}

export async function saveProfileAction(_previous: FormState, data: FormData): Promise<FormState> {
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  try {
    const yearsValue = years(text(data, 'yearsExperience'));
    await saveProfile(owner, {
      name: text(data, 'name'),
      headline: text(data, 'headline'),
      yearsExperience: Number.isNaN(yearsValue) ? 'invalid' : yearsValue,
      location: text(data, 'location'),
      careerGoals: text(data, 'careerGoals'),
      targetEmployers: splitList(text(data, 'targetEmployers')),
      expertiseAreas: splitList(text(data, 'expertiseAreas')),
    });
  } catch (err) {
    return toErrorState(err);
  }
  revalidatePath('/onboarding');
  revalidatePath('/settings/profile');
  revalidatePath('/');
  return { status: 'saved', message: 'Profile saved.' };
}

export async function savePreferencesAction(_previous: FormState, data: FormData): Promise<FormState> {
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  try {
    await savePreferences(owner, {
      tone: text(data, 'tone'),
      audience: text(data, 'audience'),
      writingStyle: text(data, 'writingStyle'),
      avoid: splitList(text(data, 'avoid')),
    });
  } catch (err) {
    return toErrorState(err);
  }
  revalidatePath('/settings/profile');
  return { status: 'saved', message: 'Brand preferences saved.' };
}

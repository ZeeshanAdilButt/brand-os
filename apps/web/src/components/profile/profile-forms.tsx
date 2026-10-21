'use client';

import { useActionState } from 'react';
import { IDLE, type FormState } from '@/app/(app)/_actions/form-state';
import { savePreferencesAction, saveProfileAction } from '@/app/(app)/_actions/profile';
import { Button } from '@/components/ui/button';
import { Field, FormNotice, Input, Textarea } from '@/components/ui/field';

export interface ProfileValues {
  name: string;
  headline: string | null;
  yearsExperience: number | null;
  location: string | null;
  careerGoals: string | null;
  targetEmployers: string[];
  expertiseAreas: string[];
}

export interface PreferencesValues {
  tone: string | null;
  audience: string | null;
  writingStyle: string | null;
  avoid: string[];
}

function Notice({ state }: { state: FormState }) {
  if (state.status === 'error') return <FormNotice tone="error">{state.message ?? 'Some fields need attention.'}</FormNotice>;
  if (state.status === 'saved') return <FormNotice tone="success">{state.message ?? 'Saved.'}</FormNotice>;
  return null;
}

/** Name, headline, experience, goals and the topics you write about. Plain text; edit any time. */
export function ProfileForm({ values, submitLabel = 'Save profile' }: { values: ProfileValues; submitLabel?: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveProfileAction, IDLE);
  const err = (key: string) => state.fields?.[key];
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" htmlFor="profile-name" error={err('name')}>
          <Input id="profile-name" name="name" defaultValue={values.name} required maxLength={120} autoComplete="name" />
        </Field>
        <Field label="Years of experience" htmlFor="profile-years" error={err('yearsExperience')}>
          <Input id="profile-years" name="yearsExperience" type="number" inputMode="numeric" min={0} max={80} step={1} defaultValue={values.yearsExperience ?? ''} />
        </Field>
      </div>
      <Field label="Headline" htmlFor="profile-headline" hint="One line on what you do." error={err('headline')}>
        <Input id="profile-headline" name="headline" defaultValue={values.headline ?? ''} maxLength={200} />
      </Field>
      <Field label="Location" htmlFor="profile-location" error={err('location')}>
        <Input id="profile-location" name="location" defaultValue={values.location ?? ''} maxLength={120} />
      </Field>
      <Field label="Career goals" htmlFor="profile-goals" hint="The roles or kind of work you are aiming for." error={err('careerGoals')}>
        <Textarea id="profile-goals" name="careerGoals" defaultValue={values.careerGoals ?? ''} rows={3} maxLength={2000} />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Target employers" htmlFor="profile-employers" hint="One per line or comma separated.">
          <Textarea id="profile-employers" name="targetEmployers" defaultValue={values.targetEmployers.join('\n')} rows={4} />
        </Field>
        <Field label="Areas of expertise" htmlFor="profile-expertise" hint="One per line or comma separated.">
          <Textarea id="profile-expertise" name="expertiseAreas" defaultValue={values.expertiseAreas.join('\n')} rows={4} />
        </Field>
      </div>
      <Notice state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** How your writing should sound, who it is for, and what to avoid. */
export function PreferencesForm({ values }: { values: PreferencesValues }) {
  const [state, action, pending] = useActionState<FormState, FormData>(savePreferencesAction, IDLE);
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Tone" htmlFor="pref-tone" hint="For example: plain, confident, technical.">
          <Input id="pref-tone" name="tone" defaultValue={values.tone ?? ''} maxLength={500} />
        </Field>
        <Field label="Audience" htmlFor="pref-audience" hint="Who you are writing for.">
          <Input id="pref-audience" name="audience" defaultValue={values.audience ?? ''} maxLength={500} />
        </Field>
      </div>
      <Field label="Writing style notes" htmlFor="pref-style" hint="Habits to keep: structure, level of detail, how you present numbers.">
        <Textarea id="pref-style" name="writingStyle" defaultValue={values.writingStyle ?? ''} rows={3} maxLength={2000} />
      </Field>
      <Field label="Avoid" htmlFor="pref-avoid" hint="Words, habits or topics to keep out. One per line or comma separated.">
        <Textarea id="pref-avoid" name="avoid" defaultValue={values.avoid.join('\n')} rows={3} />
      </Field>
      <Notice state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving' : 'Save preferences'}
        </Button>
      </div>
    </form>
  );
}

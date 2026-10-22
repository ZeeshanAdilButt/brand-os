import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { PreferencesForm, ProfileForm } from '@/components/profile/profile-forms';
import { SettingsTabs } from '@/components/settings-tabs';
import { sessionToOwner } from '@/server/actions/owner';
import { getProfile } from '@/server/actions/profile';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Profile' };
export const dynamic = 'force-dynamic';

export default async function ProfileSettingsPage() {
  const user = await requireSessionUser();
  const { profile, preferences } = await getProfile(sessionToOwner(user, user.ctx));

  return (
    <>
      <PageHeader eyebrow="Settings" title="Profile" description="Who you are and how you write. Only you can see this, and your drafts and knowledge search can draw on it." />
      <SettingsTabs />
      <div className="grid max-w-3xl gap-12">
        <section aria-labelledby="profile-heading">
          <h2 id="profile-heading" className=" text-xl font-semibold">
            About you
          </h2>
          <p className="mt-1 mb-5 text-sm text-muted-foreground">
            {profile ? 'Edit any field and save.' : 'No profile yet. Fill in what you want your writing to reflect; everything is optional except your name.'}
          </p>
          <ProfileForm
            values={{
              name: profile?.name ?? user.displayName,
              headline: profile?.headline ?? null,
              yearsExperience: profile?.yearsExperience ?? null,
              location: profile?.location ?? null,
              careerGoals: profile?.careerGoals ?? null,
              targetEmployers: profile?.targetEmployers ?? [],
              expertiseAreas: profile?.expertiseAreas ?? [],
            }}
          />
        </section>
        <section aria-labelledby="prefs-heading">
          <h2 id="prefs-heading" className=" text-xl font-semibold">
            Brand preferences
          </h2>
          <p className="mt-1 mb-5 text-sm text-muted-foreground">Tone, audience and things to avoid. These guide drafts once the article studio and AI assistance arrive.</p>
          <PreferencesForm
            values={{
              tone: preferences?.tone ?? null,
              audience: preferences?.audience ?? null,
              writingStyle: preferences?.writingStyle ?? null,
              avoid: preferences?.avoid ?? [],
            }}
          />
        </section>
        <section aria-labelledby="account-heading" className="rounded-xl border bg-card p-4 sm:p-5">
          <h2 id="account-heading" className=" text-lg font-semibold">
            Account
          </h2>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Mode</dt>
            <dd>{user.ctx.config.mode === 'local' ? 'Local, single owner, no sign-in' : 'Hosted account'}</dd>
            {user.email ? (
              <>
                <dt className="text-muted-foreground">Email</dt>
                <dd className="break-all">{user.email}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">User id</dt>
            <dd>
              <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8125rem]">{user.userId}</code>
            </dd>
          </dl>
        </section>
      </div>
    </>
  );
}

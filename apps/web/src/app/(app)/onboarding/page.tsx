import type { Metadata } from 'next';
import Link from 'next/link';
import { Check, FileUp, GitBranch, Link2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { DisabledOption } from '@/components/disabled-option';
import { QuickAdd } from '@/components/knowledge/quick-add';
import { PageHeader } from '@/components/page-header';
import { ProfileForm } from '@/components/profile/profile-forms';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { sessionToOwner } from '@/server/actions/owner';
import { getProfile, onboardingState } from '@/server/actions/profile';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Set up' };
export const dynamic = 'force-dynamic';

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`step-${n}`} className="grid gap-4 border-b py-8 first:pt-0 last:border-b-0 md:grid-cols-[3rem_1fr] md:gap-6">
      <div
        aria-hidden
        className={cn(
          'grid size-9 place-items-center rounded-full border font-mono text-sm',
          done ? 'border-success/50 bg-success/10 text-success' : 'border-input bg-card text-muted-foreground',
        )}
      >
        {done ? <Check className="size-4" /> : n}
      </div>
      <div className="min-w-0">
        <h2 id={`step-${n}`} className=" text-xl font-semibold">
          {title}
          {done ? <span className="ml-2 align-middle font-sans text-xs font-medium text-success">Done</span> : null}
        </h2>
        {children}
      </div>
    </section>
  );
}

export default async function OnboardingPage() {
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  const [state, { profile }] = await Promise.all([onboardingState(owner), getProfile(owner)]);
  const fresh = !state.hasProfile && state.items === 0;

  return (
    <>
      <PageHeader
        eyebrow="Set up"
        title={fresh ? 'Welcome. Start with what you know' : 'Set up your workspace'}
        description="Everything here is private to your account and optional. Add as much or as little as you like; you can change any of it later in Settings and Knowledge."
      />

      {fresh ? (
        <p className="mb-8 rounded-xl border bg-card p-4 text-sm leading-relaxed sm:p-5">
          Your account starts empty on purpose. Nothing is pre-filled, no AI key is needed, and nothing you add is visible to anyone else or used in public
          writing unless you allow it.
        </p>
      ) : null}

      <Step n={1} done={state.hasProfile} title="Tell us about you">
        <p className="mt-1 mb-5 text-sm leading-relaxed text-muted-foreground">
          A name is enough to begin. The rest helps later when drafts are shaped to your background and goals.
        </p>
        <div className="max-w-2xl">
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
        </div>
      </Step>

      <Step n={2} done={state.items > 0} title="Add what your writing draws on">
        <p className="mt-1 mb-5 text-sm leading-relaxed text-muted-foreground">
          Reading notes, certifications, projects and past articles, one item at a time. Each starts private and unverified.{' '}
          {state.items > 0 ? (
            <>
              You have {state.items} {state.items === 1 ? 'item' : 'items'}.{' '}
              <Link href="/knowledge" className="font-medium text-link underline-offset-4 hover:underline">
                Open knowledge
              </Link>
              .
            </>
          ) : null}
        </p>
        <div className="max-w-2xl">
          <QuickAdd />
          <p className="mt-4 text-sm text-muted-foreground">
            Need more control over source, date, verification or confidentiality?{' '}
            <Link href="/knowledge/new" className="font-medium text-link underline-offset-4 hover:underline">
              Use the full form
            </Link>
            .
          </p>
        </div>
      </Step>

      <Step n={3} done={false} title="Bring in what you already have">
        <p className="mt-1 mb-5 text-sm leading-relaxed text-muted-foreground">
          Imports are not built yet. Until they arrive, add items by hand above; nothing is lost by starting that way.
        </p>
        <ul className="grid max-w-3xl gap-3 sm:grid-cols-3">
          <DisabledOption icon={FileUp} title="Resume upload" description="Read a resume and propose items for you to review." action="Upload a resume" day={3} />
          <DisabledOption icon={GitBranch} title="GitHub import" description="Turn repositories and write-ups into project items." action="Connect GitHub" day={27} />
          <DisabledOption icon={Link2} title="Source connections" description="Link accounts and sites you publish on." action="Add a connection" day={5} />
        </ul>
      </Step>

      <div className="pt-2">
        <Link href="/knowledge" className={buttonVariants({ variant: state.items > 0 ? 'default' : 'outline' })}>
          Go to knowledge
        </Link>
      </div>
    </>
  );
}

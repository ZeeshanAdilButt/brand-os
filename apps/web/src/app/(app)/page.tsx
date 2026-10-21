import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, BrainCircuit, Database, HardDrive, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { NAV_ITEMS } from '@/lib/nav';
import { ROADMAP } from '@/lib/roadmap';
import { driverLabel, formatLatency, modeLabel } from '@/lib/status';
import { sessionToOwner } from '@/server/actions/owner';
import { onboardingState } from '@/server/actions/profile';
import { getHealth } from '@/server/actions/system';
import { requireSessionUser } from '@/server/auth/session';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

function Fact({ icon: Icon, title, children, tone }: { icon: typeof Database; title: string; children: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <Card className="gap-3 py-4 sm:py-5">
      <CardContent className="flex flex-col gap-2 px-4 sm:px-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon aria-hidden className="size-4" />
          {title}
          {tone ? (
            <span
              aria-hidden
              className={cn('ml-auto size-2 rounded-full', tone === 'ok' ? 'bg-success' : tone === 'warn' ? 'bg-warning' : 'bg-destructive')}
            />
          ) : null}
        </div>
        <div className="text-sm leading-relaxed">{children}</div>
      </CardContent>
    </Card>
  );
}

export default async function OverviewPage() {
  const [health, user] = await Promise.all([getHealth(), requireSessionUser()]);
  const setup = await onboardingState(sessionToOwner(user, user.ctx));
  const tone = health.status === 'ok' ? 'ok' : health.status === 'degraded' ? 'warn' : 'bad';

  return (
    <>
      <PageHeader
        eyebrow="Engineering Brand OS"
        title="Write once, publish with control"
        description="A studio for technical articles that runs on your machine. Your drafts and private notes stay with you, AI is optional, and nothing is published without your explicit approval."
      />

      {!setup.hasProfile && setup.items === 0 ? (
        <Link
          href="/onboarding"
          className="mb-8 flex items-center gap-4 rounded-xl border border-primary/40 bg-card p-4 transition-colors hover:bg-accent sm:p-5"
        >
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Finish setting up</span>
            <span className="block text-sm text-muted-foreground">Add your profile and a first knowledge item. It takes a couple of minutes and everything stays private.</span>
          </span>
          <ArrowRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      ) : null}

      <section aria-label="System summary" className="mb-12 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Fact icon={HardDrive} title="Mode">
          <p className="font-medium">{modeLabel(health.mode)}</p>
          <p className="text-muted-foreground">{health.mode === 'local' ? 'One owner, data on this machine.' : health.mode === 'hosted' ? 'Many isolated accounts.' : 'Check the environment.'}</p>
        </Fact>
        <Fact icon={Database} title="Database" tone={tone}>
          <p className="font-medium">{driverLabel(health.db.driver, true)}</p>
          <p className="text-muted-foreground">
            {health.status === 'ok'
              ? `Responding in ${formatLatency(health.db.latencyMs)}.`
              : health.status === 'degraded'
                ? 'Reachable, migrations pending.'
                : (health.db.error ?? 'Unavailable.')}
          </p>
        </Fact>
        <Fact icon={BrainCircuit} title="AI">
          <p className="font-medium">Off</p>
          <p className="text-muted-foreground">Optional. Every feature works without it.</p>
        </Fact>
        <Fact icon={ShieldCheck} title="Publishing">
          <p className="font-medium">Approval required</p>
          <p className="text-muted-foreground">One explicit approval per action.</p>
        </Fact>
      </section>

      <section aria-labelledby="areas-heading" className="mb-12">
        <h2 id="areas-heading" className="mb-4 font-serif text-2xl font-semibold">
          Where things live
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {NAV_ITEMS.map(({ href, label, description, icon: Icon }) => (
            <li key={href}>
              <Link
                href={href}
                className="group flex h-full items-center gap-4 rounded-xl border bg-card p-4 transition-colors hover:bg-accent"
              >
                <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-link">
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{label}</span>
                  <span className="block truncate text-sm text-muted-foreground">{description}</span>
                </span>
                <ArrowRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform motion-safe:group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="roadmap-heading">
        <h2 id="roadmap-heading" className="mb-1 font-serif text-2xl font-semibold">
          Phase 1 plan
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">Technical article publishing, built one working slice at a time.</p>
        <ol className="divide-y rounded-xl border bg-card">
          {ROADMAP.map(({ day, title, summary, built }) => (
            <li key={day} className="flex flex-col gap-1 px-4 py-3.5 sm:flex-row sm:items-baseline sm:gap-4">
              <span className="label-caps w-14 shrink-0 text-muted-foreground">Day {day}</span>
              <span className="font-medium sm:w-56 sm:shrink-0">{title}</span>
              <span className="flex-1 text-sm text-muted-foreground">{summary}</span>
              <Badge variant={built ? 'default' : 'outline'} className="w-fit self-start sm:self-center">
                {built ? 'Built' : 'Planned'}
              </Badge>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

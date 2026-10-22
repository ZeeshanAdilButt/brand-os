import path from 'node:path';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppearanceSetting } from '@/components/appearance-setting';
import { PageHeader } from '@/components/page-header';
import { SettingsTabs } from '@/components/settings-tabs';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { driverLabel, formatLatency, modeLabel } from '@/lib/status';
import Link from 'next/link';
import { listProviders } from '@/server/actions/ai-providers';
import { sessionToOwner } from '@/server/actions/owner';
import { requireSessionUser } from '@/server/auth/session';
import { getHealth } from '@/server/actions/system';
import { ConfigError, loadConfig } from '@/server/config';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-b py-8 first:pt-0 last:border-b-0 md:grid-cols-[14rem_1fr] md:gap-10">
      <div>
        <h2 className=" text-xl font-semibold">{title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b py-3 first:pt-0 last:border-b-0 last:pb-0 sm:flex-row sm:items-baseline sm:gap-6">
      <dt className="w-40 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm font-medium">{children}</dd>
    </div>
  );
}

export default async function SettingsPage() {
  const user = await requireSessionUser();
  const [health, providers] = await Promise.all([getHealth(), listProviders(sessionToOwner(user, user.ctx))]);
  const ready = providers.filter((p) => p.ready);
  const fallback = providers.find((p) => p.isDefault) ?? providers[0];
  let dataDir: string | null = null;
  try {
    const config = loadConfig();
    // Show where local data lives. Never show the hosted connection string.
    if (config.mode === 'local') dataDir = path.resolve(config.dataDir);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
  }
  const statusBadge =
    health.status === 'ok' ? (
      <Badge className="bg-success text-background">Healthy</Badge>
    ) : health.status === 'degraded' ? (
      <Badge className="bg-warning text-background">Migrations pending</Badge>
    ) : (
      <Badge className="bg-destructive text-background">Unavailable</Badge>
    );

  return (
    <>
      <PageHeader title="Settings" description="Appearance, AI, your data and the state of this installation." />
      <SettingsTabs />

      <Section title="Appearance" description="Saved in this browser only.">
        <AppearanceSetting />
      </Section>

      <Section title="System" description="Live values from the running app.">
        <dl>
          <Row label="Status">{statusBadge}</Row>
          <Row label="Mode">{modeLabel(health.mode)}</Row>
          <Row label="Database">{driverLabel(health.db.driver, true)}</Row>
          <Row label="Response time">{formatLatency(health.db.latencyMs)}</Row>
          <Row label="Schema">
            {health.db.schema === 'ready' ? 'Up to date' : health.db.schema === 'pending' ? 'Migrations pending (run pnpm db:migrate)' : 'Unknown'}
          </Row>
          {health.db.error ? <Row label="Problem">{health.db.error}</Row> : null}
        </dl>
      </Section>

      {dataDir ? (
        <Section title="Your data" description="Local mode keeps everything on this machine.">
          <dl>
            <Row label="Data folder">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8125rem]">{dataDir}</code>
            </Row>
          </dl>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            Back it up by copying this folder while the app is stopped. It is excluded from git.
          </p>
        </Section>
      ) : null}

      <Section title="Accounts for publishing" description="Keys and sign-ins for DEV.to, Hashnode, your site and more.">
        <p className="text-sm leading-relaxed">Accounts now live under Platforms, with a setup card for every platform and a guided connect for the ones that work today.</p>
        <Link href="/platforms/integrations" className={buttonVariants({ variant: 'outline', className: 'mt-4' })}>
          Open Integrations
        </Link>
      </Section>

      <Section title="Export and deletion" description="Your data is yours to take with you.">
        <p className="text-sm leading-relaxed">
          Download everything you hold in one JSON file: your profile, brand preferences, sources and knowledge items. It contains only your own data.
        </p>
        <a href="/api/export" download="brand-os-export.json" className={buttonVariants({ variant: 'outline', className: 'mt-4' })}>
          Download my data
        </a>
        <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
          You can delete a single knowledge item from its edit page. Deleting your whole account and everything in it is not built yet, so there is no
          account-wide delete button. Export is always available.
        </p>
      </Section>

      <Section title="AI" description="Optional. Every feature works without it.">
        {providers.length === 0 ? (
          <p className="text-sm leading-relaxed">
            No AI provider is set up, and none is needed. You can add a local model, your own API key, or hand tasks to your own Claude Code.
          </p>
        ) : (
          <p className="text-sm leading-relaxed">
            {ready.length === 0
              ? `${providers.length} provider${providers.length === 1 ? ' is' : 's are'} saved, but none is ready to use yet.`
              : `${ready.length} of ${providers.length} provider${providers.length === 1 ? ' is' : 's are'} ready.`}
            {fallback ? ` Default: ${fallback.name}${fallback.trust === 'external' ? ' (sends text to an outside service when you ask for help)' : ' (stays on your machine or network)'}.` : ''}
          </p>
        )}
        <Link href="/settings/ai" className={buttonVariants({ variant: 'outline', className: 'mt-4' })}>
          Manage AI providers
        </Link>
      </Section>
    </>
  );
}

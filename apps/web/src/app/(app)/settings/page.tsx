import path from 'node:path';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppearanceSetting } from '@/components/appearance-setting';
import { PageHeader } from '@/components/page-header';
import { SettingsTabs } from '@/components/settings-tabs';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { driverLabel, formatLatency, modeLabel } from '@/lib/status';
import { getHealth } from '@/server/actions/system';
import { ConfigError, loadConfig } from '@/server/config';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-b py-8 first:pt-0 last:border-b-0 md:grid-cols-[14rem_1fr] md:gap-10">
      <div>
        <h2 className="font-serif text-xl font-semibold">{title}</h2>
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
  const health = await getHealth();
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
      <PageHeader eyebrow="Settings" title="Settings" description="Appearance, your data and the state of this installation." />
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

      <Section title="Export and deletion" description="Your data is yours to take with you.">
        <p className="text-sm leading-relaxed">
          Download everything you hold in one JSON file: your profile, brand preferences, sources and knowledge items. It contains only your own data.
        </p>
        <a href="/api/export" download="brand-os-export.json" className={buttonVariants({ variant: 'outline', className: 'mt-4' })}>
          Download my data
        </a>
        <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
          You can delete a single knowledge item from its edit page today. Deleting your whole account and everything in it arrives on Day 27; until then
          there is no account-wide delete button, and none is shown.
        </p>
      </Section>

      <Section title="AI" description="Optional. Every feature works without it.">
        <p className="text-sm leading-relaxed">
          No AI provider is configured and none is needed. Provider settings (a local Ollama model or your own API key)
          and the Claude Code connection arrive on Day 4.
        </p>
      </Section>
    </>
  );
}

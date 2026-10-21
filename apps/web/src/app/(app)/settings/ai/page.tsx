import type { Metadata } from 'next';
import { ProvidersManager } from '@/components/ai/providers-manager';
import { PageHeader } from '@/components/page-header';
import { SettingsTabs } from '@/components/settings-tabs';
import { listProviders } from '@/server/actions/ai-providers';
import { sessionToOwner } from '@/server/actions/owner';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'AI settings' };
export const dynamic = 'force-dynamic';

export default async function AiSettingsPage() {
  const user = await requireSessionUser();
  const providers = await listProviders(sessionToOwner(user, user.ctx));
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="AI"
        description="Optional. Use a model on your own machine, your own API key, or your own Claude Code. The app never calls a model you have not set up here."
      />
      <SettingsTabs />
      <ProvidersManager initial={providers} mode={user.ctx.config.mode} />
    </>
  );
}

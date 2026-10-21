import type { Metadata } from 'next';
import { ConnectionsManager } from '@/components/publishing/connections-manager';
import { PageHeader } from '@/components/page-header';
import { SettingsTabs } from '@/components/settings-tabs';
import { sessionToOwner } from '@/server/actions/owner';
import { listConnections } from '@/server/actions/publishing';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Connections' };
export const dynamic = 'force-dynamic';

export default async function ConnectionsPage() {
  const user = await requireSessionUser();
  const views = await listConnections(sessionToOwner(user, user.ctx));
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Connections"
        description="The accounts you publish to. Each key is stored for you alone, encrypted, and never shown back. Connecting an account does not publish anything."
      />
      <SettingsTabs />
      <ConnectionsManager initial={views} />
    </>
  );
}

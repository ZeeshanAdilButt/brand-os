import type { Metadata } from 'next';
import { CredentialsManager } from '@/components/agent/credentials-manager';
import { PageHeader } from '@/components/page-header';
import { SettingsTabs } from '@/components/settings-tabs';
import { listCredentials } from '@/server/actions/agent-credentials';
import { sessionToOwner } from '@/server/actions/owner';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Agent access' };
export const dynamic = 'force-dynamic';

export default async function AgentAccessPage() {
  const user = await requireSessionUser();
  const credentials = await listCredentials(sessionToOwner(user, user.ctx));
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Agent access"
        description="Let your own Claude Code read and edit your articles over MCP. Each credential is yours, limited to the scopes you pick, and can be revoked at once."
      />
      <SettingsTabs />
      <CredentialsManager initial={credentials} />
    </>
  );
}

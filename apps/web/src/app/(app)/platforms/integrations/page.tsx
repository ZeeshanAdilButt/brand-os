import type { Metadata } from 'next';
import { IntegrationsHub } from '@/components/integrations/integrations-hub';
import { getSiteSettings } from '@/server/actions/composer';
import { listIntegrations } from '@/server/actions/integrations';
import { sessionToOwner } from '@/server/actions/owner';
import { listConnections } from '@/server/actions/publishing';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Integrations' };
export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  const [connections, saved, site] = await Promise.all([listConnections(owner), listIntegrations(owner), getSiteSettings(owner)]);
  return <IntegrationsHub connections={connections} saved={saved} site={site} appUrl={user.ctx.config.appUrl} />;
}

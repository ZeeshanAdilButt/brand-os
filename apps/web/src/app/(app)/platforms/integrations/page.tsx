import type { Metadata } from 'next';
import { IntegrationsHub } from '@/components/integrations/integrations-hub';
import { getSiteSettings } from '@/server/actions/composer';
import { listConnectors } from '@/server/actions/connect';
import { sessionToOwner } from '@/server/actions/owner';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Integrations' };
export const dynamic = 'force-dynamic';

const RESULT_CODES = new Set(['connected', 'denied', 'state', 'session', 'exchange', 'check', 'expired', 'error']);

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  const query = await searchParams;
  const [connectors, site] = await Promise.all([listConnectors(owner, { config: user.ctx.config }), getSiteSettings(owner)]);
  const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : null);
  const result = one(query.result);
  return <IntegrationsHub connectors={connectors} site={site} initial={{ connect: one(query.connect), result: result && RESULT_CODES.has(result) ? result : null }} />;
}

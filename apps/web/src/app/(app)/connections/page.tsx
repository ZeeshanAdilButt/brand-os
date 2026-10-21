import type { Metadata } from 'next';
import { Plug } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';
import { PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Connections' };

export default function ConnectionsPage() {
  return (
    <>
      <PageHeader eyebrow="Connections" title="Publishing destinations" description="Connect the accounts you publish to. Credentials are stored for you alone and are never shown back." />
      <ComingSoon
        day={5}
        icon={Plug}
        heading="Connections arrive with the publishing adapters"
        lead="Each destination shows its connection state, what it can do (drafts, canonical URLs, scheduling) and what it cannot."
        items={[
          'DEV.to connection with a clear connected, expired or missing state',
          'Hashnode connection where the API is available to your plan',
          'Medium handled as an import flow, since it no longer issues new API tokens',
          'Disconnect at any time, which removes the stored credential',
        ]}
      />
    </>
  );
}

import type { Metadata } from 'next';
import { Send } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';
import { PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Publishing' };

export default function PublishingPage() {
  return (
    <>
      <PageHeader eyebrow="Publishing" title="Preview and publish" description="One article, several destinations, each reviewed and approved on its own. Nothing goes out without your explicit approval." />
      <ComingSoon
        day={5}
        icon={Send}
        heading="Publishing arrives with the first connector"
        lead="The first destination is DEV.to, built on the approval gate that already exists in the command-line tool. The side-by-side composer follows on Day 6."
        items={[
          'DEV.to first, with canonical URL back to your own site and tags',
          'Hashnode where its API allows it',
          'Per-destination preview, edit and diff before anything is sent (Day 6)',
          'Individual or approved-batch publishing with retries and result links (Day 6)',
        ]}
        today="The command-line tool and the Claude Code MCP server from Phase 0 can already publish to DEV.to after explicit approval."
      />
    </>
  );
}

import type { Metadata } from 'next';
import { FileText } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';
import { PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Articles' };

export default function ArticlesPage() {
  return (
    <>
      <PageHeader eyebrow="Articles" title="Your technical articles" description="Write, import and version long-form technical writing, then preview it exactly as each destination will show it." />
      <ComingSoon
        day={3}
        icon={FileText}
        heading="The article studio is next on the list"
        lead="A Markdown editor built for technical writing. It works fully offline and does not need any AI."
        items={[
          'Markdown editor that keeps code blocks, links, tables and diagrams intact',
          'Import from a file, a URL or your personal site',
          'Metadata, assets, autosave and full version history',
          'Draft states with a reading preview and an editing preview',
        ]}
      />
    </>
  );
}

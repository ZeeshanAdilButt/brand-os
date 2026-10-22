import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { ImportTabs } from '@/components/articles/import-tabs';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { getFolderStatus } from '@/server/actions/import';
import { sessionToOwner } from '@/server/actions/owner';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Import an article' };
export const dynamic = 'force-dynamic';

export default async function ImportArticlePage() {
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  const folder = await getFolderStatus(owner, user.ctx.config.mode);

  return (
    <>
      <PageHeader title="Import an article" description="Each import makes a draft, keeps code blocks, tables, links and diagrams, and tells you about anything it could not carry across.">
        <Link href="/articles" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          <ArrowLeft aria-hidden />
          All articles
        </Link>
      </PageHeader>
      <ImportTabs folder={folder} />
    </>
  );
}

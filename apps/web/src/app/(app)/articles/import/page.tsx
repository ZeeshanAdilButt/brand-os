import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { ImportFile, ImportFolder, ImportUrl } from '@/components/articles/import-panels';
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
      <PageHeader
        eyebrow="Articles"
        title="Import an article"
        description="Bring in writing you already have. Each import creates a draft with its own history entry, keeps code blocks, tables, links and diagrams, and tells you about anything it could not carry across."
      >
        <div>
          <Link href="/articles" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            <ArrowLeft aria-hidden />
            All articles
          </Link>
        </div>
      </PageHeader>
      <div className="grid max-w-3xl gap-5">
        <ImportFile />
        <ImportUrl />
        <ImportFolder initial={folder} />
      </div>
    </>
  );
}

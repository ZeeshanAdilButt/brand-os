import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
      <PageHeader eyebrow="404" title="That page does not exist" description="The link may be old, or the feature may not be built yet." />
      <Link href="/" className={buttonVariants()}>
        Back to the overview
      </Link>
    </main>
  );
}

'use client';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
      <PageHeader eyebrow="Error" title="Something went wrong" description="The page failed to load. Try again, and check the system status if it keeps happening." />
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}

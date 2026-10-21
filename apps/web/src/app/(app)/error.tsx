'use client';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <PageHeader eyebrow="Error" title="Something went wrong" description="The page failed to load. Check Settings for the system status, then try again." />
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </>
  );
}

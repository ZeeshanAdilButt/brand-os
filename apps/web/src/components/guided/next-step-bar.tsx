'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { computeJourney, toJourneyDestinations, type Journey } from '@/lib/next-step';
import type { DestinationDTO } from '@/lib/publishing';

/**
 * A slim "Next step" bar for the studio and the publishing screens. It reads the article’s real destinations and
 * shows the one thing to do now. `reloadKey` makes it look again after the page changed something.
 */
export function NextStepBar({ articleId, title, hasText, destinations, reloadKey = 0 }: { articleId: string; title: string; hasText: boolean; destinations?: DestinationDTO[] | undefined; reloadKey?: number }) {
  const [fetched, setFetched] = useState<DestinationDTO[] | null>(null);
  useEffect(() => {
    if (destinations) return;
    let current = true;
    const timer = window.setTimeout(
      () => {
        void api<{ destinations: DestinationDTO[] }>(`/api/articles/${articleId}/destinations`).then((result) => {
          if (current && result.ok) setFetched(result.data.destinations);
        });
      },
      fetched === null ? 0 : 600,
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
    // `fetched` only decides whether the first load waits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId, reloadKey, destinations]);

  const list = destinations ?? fetched;
  if (!list) return <div aria-hidden className="h-12 rounded-lg border bg-surface" />;
  const journey: Journey = computeJourney({ articleCount: 1, article: { id: articleId, title, hasText }, destinations: toJourneyDestinations(list) });
  const current = journey.steps.find((s) => s.state === 'current');
  return (
    <div role="region" aria-label="Next step" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-surface px-4 py-2.5">
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-semibold">Next step</span>
        {current ? <span className="text-muted-foreground"> · {current.label}</span> : null}
        <span className="ml-2 hidden text-muted-foreground md:inline">{journey.next.why}</span>
      </p>
      <Link href={journey.next.href} className={buttonVariants({ size: 'sm' })}>
        {journey.next.label}
        <ArrowRight aria-hidden />
      </Link>
    </div>
  );
}

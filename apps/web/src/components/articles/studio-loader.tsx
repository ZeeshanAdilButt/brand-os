'use client';

import dynamic from 'next/dynamic';
import type { ArticleDTO } from '@/lib/articles';

function StudioSkeleton() {
  return (
    <div className="flex h-[calc(100dvh-5.25rem)] min-h-[34rem] flex-col overflow-hidden rounded-xl border bg-card shadow-soft" aria-busy="true" aria-label="Opening the studio">
      <div className="flex items-center gap-3 border-b bg-background p-3">
        <div className="size-9 animate-pulse rounded-md bg-muted" />
        <div className="h-6 w-1/2 animate-pulse rounded bg-muted" />
      </div>
      <div className="grid flex-1 content-start gap-3 p-5">
        {[90, 70, 84, 46, 78].map((width, i) => (
          <div key={i} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${width}%` }} />
        ))}
      </div>
    </div>
  );
}

// The studio reads the window size and talks to the browser's storage of focus and scroll; it renders in the browser only.
const Studio = dynamic(() => import('./studio').then((m) => m.Studio), { ssr: false, loading: () => <StudioSkeleton /> });

export function StudioLoader({ initial }: { initial: ArticleDTO }) {
  return <Studio initial={initial} />;
}

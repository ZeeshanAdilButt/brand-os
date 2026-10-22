'use client';

import { Copy, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { StatusChip } from '@/components/ui/status-chip';
import { draftChip } from '@/lib/chips';
import { formatWhen } from '@/lib/format';
import { PLATFORMS, type DestinationDTO } from '@/lib/publishing';
import { cn } from '@/lib/utils';

/** Step 4: every destination in one list, with its outcome, its live link and what to do about anything unfinished. */
export function PublishResults({ destinations, articleId, onOpen }: { destinations: DestinationDTO[]; articleId: string; onOpen(platform: DestinationDTO['platform']): void }) {
  const [copied, setCopied] = useState(false);
  const rows = destinations.filter((d) => d.added);
  const live = rows.filter((d) => d.draft?.status === 'published' && d.draft.remoteUrl);
  const links = live.map((d) => `${PLATFORMS[d.platform].name}: ${d.draft!.remoteUrl}`).join('\n');
  const unfinished = rows.filter((d) => d.draft?.status !== 'published');

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(links);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  if (rows.length === 0) return <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">No destinations yet. Go back and choose where this article should go.</p>;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="lg" disabled={live.length === 0} onClick={() => void copyAll()}>
          <Copy aria-hidden />
          <span aria-live="polite">{copied ? 'Copied' : `Copy all live links (${live.length})`}</span>
        </Button>
        <p className="text-sm text-muted-foreground">
          {live.length} of {rows.length} {rows.length === 1 ? 'destination is' : 'destinations are'} out.
        </p>
      </div>

      <ul className="grid gap-3" aria-label="Results">
        {rows.map((d) => {
          const draft = d.draft;
          const info = PLATFORMS[d.platform];
          return (
            <li key={d.platform} className="grid gap-2 rounded-xl border bg-surface p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold">{info.name}</span>
                  <StatusChip chip={draftChip(d.platform, draft)} />
                </p>
                <p className="mt-0.5 truncate text-sm text-muted-foreground">
                  {draft?.payload.title || 'Not prepared'}
                  {draft?.account ? ` · ${draft.account}` : ''}
                  {draft?.publishedAt ? ` · ${formatWhen(draft.publishedAt)}` : ''}
                </p>
                {draft?.status === 'published' && draft.publishedVia === 'manual' ? <p className="mt-0.5 text-xs text-muted-foreground">Recorded by you. This app did not publish it.</p> : null}
                {draft?.status === 'published' && d.platform === 'site' && draft.publishedVia !== 'manual' ? <p className="mt-0.5 text-xs text-muted-foreground">A pull request was opened. Merge it in GitHub to go live.</p> : null}
                {draft?.remoteUrl && draft.status === 'published' ? (
                  <a href={draft.remoteUrl} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex max-w-full items-center gap-1 text-sm font-medium break-all text-link underline underline-offset-2">
                    {draft.remoteUrl}
                    <ExternalLink aria-hidden className="size-3.5 shrink-0" />
                  </a>
                ) : null}
                {draft?.failureMessage && (draft.status === 'failed' || draft.status === 'unknown') ? <p className="mt-1 text-sm text-muted-foreground">{draft.failureMessage}</p> : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {draft?.status === 'published' && draft.remoteUrl ? (
                  <>
                    <a href={draft.remoteUrl} target="_blank" rel="noreferrer noopener" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                      Open
                    </a>
                    <CopyLinkButton url={draft.remoteUrl} />
                  </>
                ) : (
                  <Button type="button" size="sm" variant={draft?.status === 'unknown' ? 'default' : 'outline'} onClick={() => onOpen(d.platform)}>
                    {draft?.status === 'unknown' ? 'Check status' : draft?.status === 'failed' ? 'Fix and try again' : 'Finish this one'}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <section aria-labelledby="next-heading" className={cn('rounded-xl border p-4', unfinished.length === 0 ? 'border-success/30 bg-success-subtle' : 'bg-surface')}>
        <h3 id="next-heading" className="text-base font-semibold">
          What to do next
        </h3>
        <ul className="mt-2 grid gap-1.5 pl-5 text-sm leading-6">
          {unfinished.length === 0 ? <li className="list-disc">Everything you chose is out. Share the links above where your readers are.</li> : <li className="list-disc">{unfinished.length} {unfinished.length === 1 ? 'destination still needs' : 'destinations still need'} you. Use the button on each row.</li>}
          {rows.some((d) => d.platform === 'site' && d.draft?.status === 'published' && d.draft.publishedVia !== 'manual') ? <li className="list-disc">Merge the pull request on your site’s repository when you are ready for it to go live.</li> : null}
          <li className="list-disc">Check that each copy points back to your own page, and look at the live posts once.</li>
        </ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={`/articles/${articleId}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Back to the article
          </Link>
          <Link href="/publishing" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            Publishing overview
          </Link>
        </div>
      </section>
    </div>
  );
}

function CopyLinkButton({ url }: { url: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setDone(true);
          window.setTimeout(() => setDone(false), 2000);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? 'Copied' : 'Copy link'}
    </Button>
  );
}

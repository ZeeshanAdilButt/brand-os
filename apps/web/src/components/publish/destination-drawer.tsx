'use client';

import { Check, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { StatusChip } from '@/components/ui/status-chip';
import { draftChip } from '@/lib/chips';
import type { DestinationDTO } from '@/lib/publishing';
import { cn } from '@/lib/utils';
import type { AiState } from './ai-assist';
import { ApprovalReview, type SiteFacts } from './approval-review';
import { DestinationEditor } from './destination-editor';
import type { PublishApi } from './use-publish';

export type DrawerTab = 'edit' | 'approve';

/**
 * One destination, full height, over the composer: edit and preview it, or review and approve it. The drawer works on
 * exactly one destination at a time, and its approval controls belong to that destination’s own post only.
 */
export function DestinationDrawer({
  destination,
  api,
  article,
  ai,
  facts,
  tab,
  onTab,
  onClose,
  onApplied,
}: {
  destination: DestinationDTO | null;
  api: PublishApi;
  article: { title: string; body: string };
  ai: AiState;
  facts: SiteFacts;
  tab: DrawerTab;
  onTab(tab: DrawerTab): void;
  onClose(): void;
  onApplied(): void;
}) {
  const open = destination !== null;
  const draft = destination?.draft ?? null;
  const errors = draft?.lint.filter((i) => i.severity === 'error').length ?? 0;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        showCloseButton={false}
        aria-describedby="drawer-description"
        className={cn(
          'top-0 right-0 left-auto h-dvh max-h-dvh w-full max-w-none translate-x-0 translate-y-0 content-start gap-0 overflow-y-auto rounded-none border-y-0 border-r-0 p-0 shadow-none sm:max-w-none lg:w-[min(64rem,92vw)]',
          'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right motion-reduce:animate-none',
        )}
      >
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b bg-background px-4 py-3">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-lg leading-6">{destination?.info.name ?? 'Destination'}</DialogTitle>
            <DialogDescription id="drawer-description" className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
              {destination ? <StatusChip chip={draftChip(destination.platform, draft)} /> : null}
              <span>Changes here apply to this destination only.</span>
            </DialogDescription>
          </div>
          <div role="tablist" aria-label="Destination sections" className="flex gap-1">
            {(
              [
                ['edit', 'Edit and preview'],
                ['approve', errors > 0 ? 'Approve (fix first)' : 'Review and approve'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                disabled={id === 'approve' && !draft}
                onClick={() => onTab(id)}
                className={cn(
                  'h-9 rounded-lg border px-3 text-sm font-medium transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:text-muted-foreground/60',
                  tab === id ? 'border-primary bg-accent text-accent-foreground' : 'border-border bg-surface text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X aria-hidden />
          </Button>
        </header>

        {destination ? (
          <div className="min-w-0 px-4 py-4">
            {tab === 'edit' ? (
              draft ? (
                <DestinationEditor key={`${destination.platform}-${draft.id}`} destination={destination} api={api} article={article} ai={ai} onApplied={onApplied} heading={false} />
              ) : (
                <div className="grid gap-3 rounded-xl border border-dashed p-4">
                  <p className="text-sm">{destination.info.name} is not prepared yet. Preparing builds the post from your article and sends nothing.</p>
                  <div>
                    <Button type="button" disabled={api.anyBusy} onClick={() => void api.prepare(destination.platform)}>
                      <Check aria-hidden />
                      Prepare {destination.info.name}
                    </Button>
                  </div>
                </div>
              )
            ) : (
              <ApprovalReview key={destination.platform} destination={destination} api={api} facts={facts} onEdit={() => onTab('edit')} />
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

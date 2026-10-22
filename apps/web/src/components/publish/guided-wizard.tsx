'use client';

import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { api as http } from '@/lib/api-client';
import { PLATFORMS, type PlatformId } from '@/lib/catalog';
import { approveCurrent, beginPublishing, currentOf, isFinished, resume, settle, skipCurrent, startQueue, summary, type ItemState, type QueueState } from '@/lib/publish-queue';
import { workspaceHref } from '@/lib/next-step';
import type { WizardStep } from '@/lib/wizard-state';
import { cn } from '@/lib/utils';
import { ApprovalReview, type SiteFacts } from './approval-review';
import { PublishResults } from './publish-results';
import type { PublishApi } from './use-publish';

const QUEUE_LABEL: Record<ItemState, string> = {
  waiting: 'Waiting',
  review: 'Under review',
  publishing: 'Publishing',
  published: 'Done',
  failed: 'Refused',
  unknown: 'Unknown result',
  skipped: 'Skipped',
};

export interface WizardProps {
  api: PublishApi;
  articleId: string;
  facts: SiteFacts;
  initialStep: WizardStep | null;
  initialFocus: PlatformId | null;
  onChangeStep?(step: WizardStep): void;
}

/**
 * The last two steps of the guided path: approve one destination at a time, then collect the links. Choosing the
 * article and platforms and previewing them happen on the Publishing screen, which this continues from. There is no
 * "approve all": each destination shows its own exact post and has its own button.
 */
export function GuidedWizard({ api, articleId, facts, initialStep, initialFocus, onChangeStep }: WizardProps) {
  const router = useRouter();
  const [step, setStepState] = useState<3 | 4>(initialStep === 4 ? 4 : 3);
  const [focus, setFocus] = useState<PlatformId | null>(initialFocus);
  const [queue, setQueue] = useState<QueueState | null>(null);

  const ordered = useMemo(() => api.destinations.filter((d) => d.added).sort((a, b) => a.position - b.position), [api.destinations]);
  const setStep = (next: 3 | 4) => {
    setStepState(next);
    onChangeStep?.(next);
  };

  function enterReview(startAt?: PlatformId) {
    const remaining = ordered.filter((d) => d.draft && d.draft.status !== 'published').map((d) => d.platform);
    const order = startAt && remaining.includes(startAt) ? [startAt, ...remaining.filter((p) => p !== startAt)] : remaining;
    setQueue(order.length > 0 ? startQueue(order) : null);
    setStep(3);
  }
  // Arriving here from an address (or a reload) builds the queue from what is really left to do.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (step === 3 && queue === null && ordered.length > 0) enterReview(focus ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, ordered.length]);

  async function move(platform: PlatformId, direction: -1 | 1) {
    const list = ordered.map((d) => d.platform);
    const at = list.indexOf(platform);
    const to = at + direction;
    if (to < 0 || to >= list.length) return;
    [list[at], list[to]] = [list[to]!, list[at]!];
    await http(`/api/articles/${articleId}/destinations`, { method: 'PATCH', json: { order: list } });
    await api.reload();
    if (queue && !currentOf(queue)) enterReview(undefined);
  }

  const current = queue ? currentOf(queue) : null;
  const currentDestination = current ? (api.destinations.find((d) => d.platform === current) ?? null) : null;
  const stoppedOn = queue?.stopped ? (api.destinations.find((d) => d.platform === queue.stopped!.platform) ?? null) : null;
  const reviewDestination = currentDestination ?? stoppedOn ?? (focus ? (ordered.find((d) => d.platform === focus) ?? null) : null) ?? ordered[0] ?? null;

  function onSettled(platform: PlatformId, outcome: 'published' | 'failed' | 'unknown') {
    // A destination the queue stopped on may be tried again from its own screen: that resumes it first.
    setQueue((q) => (q ? settle(beginPublishing(q.stopped?.platform === platform ? resume(q) : q, platform), platform, outcome) : q));
  }

  return (
    <div className="grid gap-5">
      <nav aria-label="Steps">
        <ol className="flex flex-wrap gap-2">
          <li className="flex-1 basis-40">
            <Link href={workspaceHref(articleId)} className="flex h-11 w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium hover:bg-accent">
              <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-success text-surface">
                <Check className="size-3.5" />
              </span>
              Platforms and previews
            </Link>
          </li>
          {(
            [
              [3, 'Approve'],
              [4, 'Results'],
            ] as const
          ).map(([id, label]) => (
            <li key={id} className="flex-1 basis-40">
              <button
                type="button"
                aria-current={step === id ? 'step' : undefined}
                onClick={() => (id === 3 ? enterReview(focus ?? undefined) : setStep(4))}
                className={cn(
                  'flex h-11 w-full items-center gap-2 rounded-lg border px-3 text-left text-sm font-medium transition-colors duration-[120ms]',
                  step === id ? 'border-primary bg-accent font-semibold text-accent-foreground' : 'border-border bg-surface hover:bg-accent',
                )}
              >
                <span aria-hidden className={cn('grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold', step === id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
                  {id - 1}
                </span>
                {label}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {ordered.length === 0 ? (
        <section className="rounded-xl border bg-surface p-8 text-center">
          <h2 className="text-lg font-semibold">No platforms chosen</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Choose where this article should go and look at a preview of each, then come back to approve.</p>
          <Link href={workspaceHref(articleId)} className={buttonVariants({ className: 'mt-4' })}>
            Choose platforms
          </Link>
        </section>
      ) : null}

      {ordered.length > 0 && step === 3 ? (
        <section aria-labelledby="step3" className="grid gap-4">
          <div>
            <h2 id="step3" className="text-xl font-semibold">
              Approve one at a time
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Each destination shows its own exact post and needs its own approval. There is no “approve all”. A post goes out only when you press its own button.</p>
          </div>

          {queue ? (
            <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
              <aside aria-label="Queue" className="grid content-start gap-3">
                <p className="text-sm font-semibold">
                  {summary(queue).published} of {summary(queue).total} done
                </p>
                <ol className="grid gap-2">
                  {queue.order.map((platform, index) => {
                    const state = queue.items[platform] ?? 'waiting';
                    return (
                      <li key={platform} aria-current={current === platform ? 'step' : undefined} className={cn('flex items-center gap-2 rounded-lg border bg-surface p-2.5 text-sm', current === platform && 'border-primary bg-accent')}>
                        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold">
                          {index + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{PLATFORMS[platform].name}</span>
                          <span className={cn('block text-xs', state === 'published' ? 'text-success' : state === 'failed' ? 'text-danger' : state === 'unknown' ? 'text-warning' : 'text-muted-foreground')}>{QUEUE_LABEL[state]}</span>
                        </span>
                        {state === 'waiting' && !queue.order.some((p) => queue.items[p] === 'published') ? (
                          <span className="flex">
                            <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${PLATFORMS[platform].name} earlier`} disabled={index === 0} onClick={() => void move(platform, -1)}>
                              <ArrowUp aria-hidden />
                            </Button>
                            <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${PLATFORMS[platform].name} later`} disabled={index === queue.order.length - 1} onClick={() => void move(platform, 1)}>
                              <ArrowDown aria-hidden />
                            </Button>
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
                {queue.stopped ? (
                  <div role="alert" className="rounded-lg border border-danger/30 bg-danger-bg p-3 text-sm">
                    <p className="font-semibold">Stopped at {PLATFORMS[queue.stopped.platform].name}</p>
                    <p className="mt-1">{queue.stopped.reason}</p>
                    {queue.items[queue.stopped.platform] === 'failed' ? (
                      <Button type="button" size="sm" className="mt-2" onClick={() => setQueue((q) => (q ? resume(q) : q))}>
                        Fix it and try this one again
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {approveCurrent(queue) ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setQueue((q) => (q ? skipCurrent(q) : q))}>
                    Skip this one for now
                  </Button>
                ) : null}
              </aside>

              <div className="min-w-0">
                {isFinished(queue) ? (
                  <div className="grid gap-3 rounded-xl border border-success/30 bg-success-bg p-4">
                    <p className="font-semibold text-success">All reviewed</p>
                    <p className="text-sm">Everything in this queue is out or skipped.</p>
                    <div>
                      <Button type="button" onClick={() => setStep(4)}>
                        See the results
                        <ArrowRight aria-hidden />
                      </Button>
                    </div>
                  </div>
                ) : reviewDestination ? (
                  <div className="grid gap-3">
                    <h3 className="text-lg font-semibold">{reviewDestination.info.name}</h3>
                    <ApprovalReview
                      destination={reviewDestination}
                      api={api}
                      facts={facts}
                      {...(queue.order.filter((p) => queue.items[p] === 'waiting').length > 0 ? { approveLabel: 'Approve and next' } : {})}
                      onSettled={(outcome) => onSettled(reviewDestination.platform, outcome)}
                      onEdit={() => {
                        router.push(workspaceHref(articleId, reviewDestination.platform));
                      }}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="rounded-xl border bg-surface p-6 text-sm text-muted-foreground">Everything prepared is already out. See the results.</p>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <Link href={workspaceHref(articleId)} className={buttonVariants({ variant: 'outline' })}>
              <ArrowLeft aria-hidden />
              Platforms and previews
            </Link>
            <Button type="button" variant={queue && isFinished(queue) ? 'default' : 'outline'} onClick={() => setStep(4)}>
              Results
              <ArrowRight aria-hidden />
            </Button>
          </div>
        </section>
      ) : null}

      {ordered.length > 0 && step === 4 ? (
        <section aria-labelledby="step4" className="grid gap-4">
          <div>
            <h2 id="step4" className="text-xl font-semibold">
              Results and links
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Every destination you chose, where it stands, and the link once it is live.</p>
          </div>
          <PublishResults
            destinations={api.destinations}
            articleId={articleId}
            onOpen={(platform) => {
              setFocus(platform);
              enterReview(platform);
            }}
          />
          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <Button type="button" variant="outline" onClick={() => setStep(3)}>
              <ArrowLeft aria-hidden />
              Approve
            </Button>
            <Link href={workspaceHref(articleId)} className={buttonVariants({ variant: 'ghost' })}>
              Add another platform
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}

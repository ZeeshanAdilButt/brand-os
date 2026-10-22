'use client';

import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, GitCompare } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PreviewComparison } from '@/components/publishing/previews/preview-comparison';
import { Button } from '@/components/ui/button';
import { StatusChip } from '@/components/ui/status-chip';
import { api as http } from '@/lib/api-client';
import { PLATFORMS, type PlatformId } from '@/lib/catalog';
import { draftChip } from '@/lib/chips';
import { approveCurrent, beginPublishing, currentOf, isFinished, resume, settle, skipCurrent, startQueue, summary, type ItemState, type QueueState } from '@/lib/publish-queue';
import type { Recommendation } from '@/lib/recommend';
import { RECOMMENDED_ORDER } from '@/lib/publishing';
import { loadRemembered, loadWizard, saveRemembered, saveWizard, type WizardStep } from '@/lib/wizard-state';
import { cn } from '@/lib/utils';
import type { AiState } from './ai-assist';
import { ApprovalReview, type SiteFacts } from './approval-review';
import { DestinationEditor } from './destination-editor';
import { DestinationPicker } from './destination-picker';
import { PublishResults } from './publish-results';
import { NoticeBar } from './shared';
import type { PublishApi } from './use-publish';

const STEPS: { id: WizardStep; label: string }[] = [
  { id: 1, label: 'Destinations' },
  { id: 2, label: 'Preview and fix' },
  { id: 3, label: 'Approve' },
  { id: 4, label: 'Results' },
];

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
  article: { title: string; body: string };
  facts: SiteFacts;
  ai: AiState;
  recommendations: Recommendation[];
  initialStep: WizardStep | null;
  initialFocus: PlatformId | null;
  onChangeStep?(step: WizardStep): void;
}

/**
 * The guided path: choose destinations, preview and fix each, approve them one at a time, then collect the links.
 * It is the default for first-time use; the composer is the expert view of the same data. Progress is kept in
 * this browser so a reload loses nothing, and everything that matters (destinations, drafts, approvals) is saved on
 * the server as it changes.
 */
export function GuidedWizard({ api, articleId, article, facts, ai, recommendations, initialStep, initialFocus, onChangeStep }: WizardProps) {
  const addedNow = useMemo(() => api.destinations.filter((d) => d.added).map((d) => d.platform), [api.destinations]);
  const [step, setStepState] = useState<WizardStep>(initialStep ?? (addedNow.length > 0 ? 2 : 1));
  const [selected, setSelected] = useState<Set<PlatformId>>(new Set(addedNow));
  const [focus, setFocus] = useState<PlatformId | null>(initialFocus ?? addedNow[0] ?? null);
  const [compare, setCompare] = useState(false);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const restored = useRef(false);

  const setStep = (next: WizardStep) => {
    setStepState(next);
    onChangeStep?.(next);
  };

  // Pick up where the browser left off, unless the address says where to go.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const saved = loadWizard(window.localStorage, articleId);
    if (initialStep === null && saved.selected.length > 0) {
      // Saved choices exist only in this browser, so they are read after the first paint (never during server rendering).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelected((current) => new Set([...current, ...saved.selected]));
      setStepState(saved.step);
    }
    if (initialFocus === null && saved.focus) setFocus(saved.focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!restored.current) return;
    saveWizard(window.localStorage, articleId, { v: 1, step, selected: [...selected], focus });
  }, [articleId, step, selected, focus]);

  const toggle = (platform: PlatformId) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });

  const chosen = api.destinations.filter((d) => selected.has(d.platform) && d.added);
  const ordered = useMemo(() => [...chosen].sort((a, b) => a.position - b.position), [chosen]);
  const focusDestination = ordered.find((d) => d.platform === focus) ?? ordered[0] ?? null;

  async function prepareAll() {
    setProblems([]);
    const notes: string[] = [];
    // Deselected destinations that were added before are taken off, unless they went out.
    for (const d of api.destinations.filter((x) => x.added && !selected.has(x.platform))) {
      setPreparing(`Removing ${d.info.name}`);
      const result = await api.remove(d.platform);
      if (!result.ok) notes.push(`${d.info.name} stays: ${result.error}`);
    }
    for (const platform of RECOMMENDED_ORDER.filter((p) => selected.has(p))) {
      const d = api.destinations.find((x) => x.platform === platform);
      setPreparing(`Preparing ${PLATFORMS[platform].name}`);
      if (!d?.added && !(await api.add(platform))) {
        notes.push(`${PLATFORMS[platform].name} could not be added.`);
        continue;
      }
      if (!d?.draft) {
        const result = await api.prepare(platform);
        if (!result.ok) notes.push(`${PLATFORMS[platform].name}: ${result.error}`);
      }
    }
    // Keep the recommended order unless the owner already chose one.
    await http(`/api/articles/${articleId}/destinations`, { method: 'PATCH', json: { order: RECOMMENDED_ORDER.filter((p) => selected.has(p)) } });
    saveRemembered(window.localStorage, [...selected, ...loadRemembered(window.localStorage)]);
    await api.reload();
    setPreparing(null);
    setProblems(notes);
    if (notes.length === 0) {
      setFocus(RECOMMENDED_ORDER.find((p) => selected.has(p)) ?? null);
      setStep(2);
    }
  }

  function enterReview(startAt?: PlatformId) {
    const remaining = ordered.filter((d) => d.draft && d.draft.status !== 'published').map((d) => d.platform);
    const order = startAt && remaining.includes(startAt) ? [startAt, ...remaining.filter((p) => p !== startAt)] : remaining;
    setQueue(order.length > 0 ? startQueue(order) : null);
    setStep(3);
  }
  // Arriving at step 3 from the address (or a reload) builds the queue from what is really left to do.
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
  const currentDestination = current ? api.destinations.find((d) => d.platform === current) ?? null : null;
  const stoppedOn = queue?.stopped ? api.destinations.find((d) => d.platform === queue.stopped!.platform) ?? null : null;
  const reviewDestination = currentDestination ?? stoppedOn ?? focusDestination;

  function onSettled(platform: PlatformId, outcome: 'published' | 'failed' | 'unknown') {
    // A destination the queue stopped on may be tried again from its own screen: that resumes it first.
    setQueue((q) => (q ? settle(beginPublishing(q.stopped?.platform === platform ? resume(q) : q, platform), platform, outcome) : q));
  }

  const canGoOn: Record<WizardStep, boolean> = {
    1: selected.size > 0,
    2: ordered.length > 0 && ordered.every((d) => d.draft),
    3: true,
    4: true,
  };

  return (
    <div className="grid gap-5">
      <nav aria-label="Steps" className="flex flex-wrap gap-2">
        <ol className="flex w-full flex-wrap gap-2">
          {STEPS.map((s) => {
            const reachable = s.id === 1 || ordered.length > 0;
            return (
              <li key={s.id} className="flex-1 basis-32">
                <button
                  type="button"
                  disabled={!reachable}
                  aria-current={step === s.id ? 'step' : undefined}
                  onClick={() => (s.id === 3 ? enterReview(focus ?? undefined) : setStep(s.id))}
                  className={cn(
                    'flex h-11 w-full items-center gap-2 rounded-lg border px-3 text-left text-sm font-medium transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:text-muted-foreground/60',
                    step === s.id ? 'border-primary bg-accent text-accent-foreground' : 'border-border bg-surface hover:bg-muted',
                  )}
                >
                  <span aria-hidden className={cn('grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold', step === s.id ? 'bg-primary text-primary-foreground' : step > s.id ? 'bg-success text-background' : 'bg-muted text-muted-foreground')}>
                    {step > s.id ? <Check className="size-3.5" /> : s.id}
                  </span>
                  {s.label}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {step === 1 ? (
        <section aria-labelledby="step1" className="grid gap-4">
          <div>
            <h2 id="step1" className="text-xl font-semibold">
              Where should this article go?
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Pick as many as you like. Choosing sends nothing: it only decides which versions to prepare. Your own site first is the usual order.</p>
          </div>
          <DestinationPicker destinations={api.destinations} selected={selected} onToggle={toggle} recommendations={recommendations} />
          {problems.length > 0 ? (
            <ul className="grid gap-1 rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-sm" role="alert">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          <div className="sticky bottom-0 -mx-2 flex flex-wrap items-center gap-3 border-t bg-background/95 px-2 py-3 sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
            <Button type="button" size="lg" disabled={!canGoOn[1] || preparing !== null} onClick={() => void prepareAll()}>
              {preparing ?? (selected.size === 0 ? 'Choose a destination' : `Prepare ${selected.size} ${selected.size === 1 ? 'version' : 'versions'}`)}
              {preparing === null ? <ArrowRight aria-hidden /> : null}
            </Button>
            <p className="text-sm text-muted-foreground">Preparing builds each post from your article. It does not contact any platform.</p>
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section aria-labelledby="step2" className="grid gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="step2" className="text-xl font-semibold">
                Preview and fix each version
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">Edit anything. Changes save as you type, and the preview follows. Fix what is marked “Fix” before you approve.</p>
            </div>
            {ordered.length > 1 ? (
              <Button type="button" variant={compare ? 'default' : 'outline'} size="sm" aria-pressed={compare} onClick={() => setCompare((c) => !c)}>
                <GitCompare aria-hidden />
                Compare two
              </Button>
            ) : null}
          </div>

          {ordered.length === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">Nothing is prepared. Go back and choose destinations.</p>
          ) : (
            <>
              <div role="tablist" aria-label="Destinations" className="flex gap-1.5 overflow-x-auto pb-1">
                {ordered.map((d) => {
                  const errors = d.draft?.lint.filter((i) => i.severity === 'error').length ?? 0;
                  return (
                    <button
                      key={d.platform}
                      type="button"
                      role="tab"
                      aria-selected={focusDestination?.platform === d.platform}
                      onClick={() => {
                        setFocus(d.platform);
                        setCompare(false);
                      }}
                      className={cn(
                        'flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors duration-[120ms]',
                        focusDestination?.platform === d.platform ? 'border-primary bg-accent' : 'border-border bg-surface hover:bg-muted',
                      )}
                    >
                      <span className="font-semibold">{d.info.name}</span>
                      {errors > 0 ? <span className="rounded-full bg-danger px-1.5 text-xs font-semibold text-danger-foreground">{errors} to fix</span> : <StatusChip chip={draftChip(d.platform, d.draft)} />}
                    </button>
                  );
                })}
              </div>

              {compare ? (
                <PreviewComparison items={ordered.filter((d) => d.draft).map((d) => ({ platform: d.platform, payload: d.draft!.payload, extras: d.draft!.extras, account: d.draft!.account }))} />
              ) : focusDestination ? (
                focusDestination.draft ? (
                  <DestinationEditor key={focusDestination.platform} destination={focusDestination} api={api} article={article} ai={ai} onApplied={() => void api.reload()} />
                ) : (
                  <div className="grid gap-3 rounded-xl border border-dashed p-4">
                    <NoticeBar notice={api.notices[focusDestination.platform]} />
                    <p className="text-sm">{focusDestination.info.name} is not prepared yet.</p>
                    <div>
                      <Button type="button" onClick={() => void api.prepare(focusDestination.platform)} disabled={api.anyBusy}>
                        Prepare {focusDestination.info.name}
                      </Button>
                    </div>
                  </div>
                )
              ) : null}
            </>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <Button type="button" variant="outline" onClick={() => setStep(1)}>
              <ArrowLeft aria-hidden />
              Destinations
            </Button>
            <Button type="button" size="lg" disabled={!canGoOn[2]} onClick={() => enterReview(focus ?? undefined)}>
              Review approvals
              <ArrowRight aria-hidden />
            </Button>
            {!canGoOn[2] && ordered.length > 0 ? <p className="text-sm text-muted-foreground">Prepare every chosen destination first.</p> : null}
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section aria-labelledby="step3" className="grid gap-4">
          <div>
            <h2 id="step3" className="text-xl font-semibold">
              Approve one at a time
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Each destination shows its own exact post and needs its own approval. There is no “approve all”. A post goes out only when you press its own button.</p>
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
                    const d = api.destinations.find((x) => x.platform === platform);
                    return (
                      <li key={platform} aria-current={current === platform ? 'step' : undefined} className={cn('flex items-center gap-2 rounded-lg border bg-surface p-2.5 text-sm', current === platform && 'border-primary bg-accent/50')}>
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
                        {d?.draft ? null : null}
                      </li>
                    );
                  })}
                </ol>
                {queue.stopped ? (
                  <div role="alert" className="rounded-lg border border-danger/30 bg-danger-subtle p-3 text-sm">
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
                  <div className="grid gap-3 rounded-xl border border-success/30 bg-success-subtle p-4">
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
                        setFocus(reviewDestination.platform);
                        setStep(2);
                      }}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">Everything prepared is already out. See the results.</p>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <Button type="button" variant="outline" onClick={() => setStep(2)}>
              <ArrowLeft aria-hidden />
              Preview and fix
            </Button>
            <Button type="button" variant={queue && isFinished(queue) ? 'default' : 'outline'} onClick={() => setStep(4)}>
              Results
              <ArrowRight aria-hidden />
            </Button>
          </div>
        </section>
      ) : null}

      {step === 4 ? (
        <section aria-labelledby="step4" className="grid gap-4">
          <div>
            <h2 id="step4" className="text-xl font-semibold">
              Results and links
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Every destination you chose, where it stands, and the link once it is live.</p>
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
            <Button type="button" variant="ghost" onClick={() => setStep(1)}>
              Add another destination
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

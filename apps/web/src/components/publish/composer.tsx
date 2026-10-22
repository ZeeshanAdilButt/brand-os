'use client';

import { ArrowRight, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { AREA_STYLE } from '@/components/platforms/area-style';
import { Button, buttonVariants } from '@/components/ui/button';
import { StatusChip } from '@/components/ui/status-chip';
import { draftChip } from '@/lib/chips';
import { DIRECTORY } from '@/lib/directory';
import { computeJourney, toJourneyDestinations, workspaceHref } from '@/lib/next-step';
import { RECOMMENDED_ORDER, type DestinationDTO, type PlatformId } from '@/lib/publishing';
import { cn } from '@/lib/utils';
import type { AiState } from './ai-assist';
import type { SiteFacts } from './approval-review';
import { DestinationDrawer, type DrawerTab } from './destination-drawer';
import { OriginalPane } from './original-pane';
import { NoticeBar } from './shared';
import { SuggestionsPane } from './suggestions-pane';
import type { PublishApi } from './use-publish';

type MobileTab = 'original' | 'destinations' | 'suggestions';

interface CardAction {
  label: string;
  /** What the button does: open the drawer on a tab, run a short call, or follow a link. */
  kind: 'drawer' | 'prepare' | 'link' | 'open';
  tab?: DrawerTab;
  href?: string;
  quiet?: boolean;
}

/** The one thing to do next for a destination. It never publishes: the strongest action is "Review and approve", which opens the review. */
export function cardAction(d: DestinationDTO): { action: CardAction; hint: string } {
  const draft = d.draft;
  const name = d.info.name;
  if (!d.added) return { action: { label: 'Add and prepare', kind: 'prepare' }, hint: d.info.state === 'adapter' ? 'Not added to this article yet.' : `Not added yet. ${name} is posted by hand from here.` };
  if (!draft) return { action: { label: 'Prepare', kind: 'prepare' }, hint: 'Builds the post from your article. Sends nothing.' };
  const errors = draft.lint.filter((i) => i.severity === 'error').length;
  switch (draft.status) {
    case 'published':
      return draft.remoteUrl
        ? { action: { label: 'Open the live post', kind: 'open', href: draft.remoteUrl, quiet: true }, hint: draft.publishedVia === 'manual' ? 'You posted this by hand.' : 'Published.' }
        : { action: { label: 'See details', kind: 'drawer', tab: 'approve', quiet: true }, hint: 'Published.' };
    case 'unknown':
      return { action: { label: 'Check status', kind: 'drawer', tab: 'approve' }, hint: 'The last publish has an unknown result. Checking only reads.' };
    case 'failed':
      return { action: { label: 'Fix and try again', kind: 'drawer', tab: 'approve' }, hint: 'The platform refused it. Nothing went out.' };
    case 'source_changed':
      return { action: { label: 'Rebuild', kind: 'drawer', tab: 'approve' }, hint: 'The article changed after this was built.' };
    case 'publishing':
      return { action: { label: 'See progress', kind: 'drawer', tab: 'approve', quiet: true }, hint: 'Being sent now.' };
    default:
      break;
  }
  if (errors > 0) return { action: { label: `Fix ${errors} ${errors === 1 ? 'problem' : 'problems'}`, kind: 'drawer', tab: 'edit' }, hint: 'A problem blocks approval until it is fixed.' };
  if (d.info.state !== 'adapter') return { action: { label: 'Post by hand', kind: 'drawer', tab: 'approve' }, hint: `Copy it, post it on ${name}, then record the link.` };
  if (d.connection?.status !== 'connected') return { action: { label: `Connect ${name}`, kind: 'link', href: `/platforms/integrations#${d.platform}` }, hint: 'Needs your account before it can be staged.' };
  return { action: { label: 'Review and approve', kind: 'drawer', tab: 'approve' }, hint: draft.status === 'pending_approval' ? 'Waiting for your approval.' : 'Ready for your review. Nothing goes out until you approve.' };
}

/**
 * The expert view: the article, every destination and the checks side by side. Cards show where each destination
 * stands and offer one next action; the drawer holds editing and review. Nothing in this screen sends anything on its
 * own, and no keyboard shortcut approves or publishes.
 */
export function Composer({
  api,
  articleId,
  article,
  html,
  facts,
  ai,
  initialFocus,
  onFocusChange,
}: {
  api: PublishApi;
  articleId: string;
  article: { title: string; body: string };
  html: string;
  facts: SiteFacts;
  ai: AiState;
  initialFocus: PlatformId | null;
  onFocusChange?(platform: PlatformId | null): void;
}) {
  const [mobileTab, setMobileTab] = useState<MobileTab>('destinations');
  const [open, setOpen] = useState<PlatformId | null>(initialFocus);
  const [tab, setTab] = useState<DrawerTab>('edit');
  const [jump, setJump] = useState<{ quote: string; nonce: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  const added = useMemo(() => api.destinations.filter((d) => d.added).sort((a, b) => a.position - b.position), [api.destinations]);
  const others = useMemo(() => api.destinations.filter((d) => !d.added).sort((a, b) => RECOMMENDED_ORDER.indexOf(a.platform) - RECOMMENDED_ORDER.indexOf(b.platform)), [api.destinations]);
  const journey = useMemo(
    () => computeJourney({ articleCount: 1, article: { id: articleId, title: article.title, hasText: article.body.trim().length > 0 }, destinations: toJourneyDestinations(api.destinations) }),
    [api.destinations, articleId, article.title, article.body],
  );
  const openDestination = open ? (api.destinations.find((d) => d.platform === open) ?? null) : null;

  function openDrawer(platform: PlatformId, nextTab: DrawerTab, from?: HTMLElement | null) {
    opener.current = from ?? (document.activeElement as HTMLElement | null);
    setTab(nextTab);
    setOpen(platform);
    onFocusChange?.(platform);
  }
  function closeDrawer() {
    setOpen(null);
    onFocusChange?.(null);
    // Give the focus back to the card that opened the drawer.
    window.setTimeout(() => opener.current?.focus(), 0);
  }

  async function run(d: DestinationDTO, button: HTMLElement | null) {
    const { action } = cardAction(d);
    if (action.kind === 'prepare') {
      if (!d.added && !(await api.add(d.platform))) return;
      const result = await api.prepare(d.platform);
      if (result.ok) openDrawer(d.platform, 'edit', button);
      return;
    }
    if (action.kind === 'drawer') openDrawer(d.platform, action.tab ?? 'edit', button);
  }

  // j / k and the arrow keys move between cards. Nothing here, or anywhere in this screen, approves or publishes.
  function onListKey(event: React.KeyboardEvent<HTMLUListElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const delta = event.key === 'j' || event.key === 'ArrowDown' ? 1 : event.key === 'k' || event.key === 'ArrowUp' ? -1 : 0;
    if (delta === 0) return;
    const buttons = Array.from(list.current?.querySelectorAll<HTMLElement>('[data-card-action]') ?? []);
    const at = buttons.indexOf(target.closest('[data-card-action]') as HTMLElement);
    const next = buttons[at + delta];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  const canonical = useMemo(() => {
    const withUrl = added.find((d) => d.draft?.payload.canonicalUrl);
    if (!withUrl) return { text: 'No canonical URL is set. Add one in the article’s details so every copy points back to your page.', tone: 'none' as const };
    const check = withUrl.draft!.canonical;
    if (!check) return { text: `${withUrl.draft!.payload.canonicalUrl} has not been checked yet.`, tone: 'none' as const };
    return { text: check.message, tone: check.state === 'live' ? ('ok' as const) : ('warn' as const) };
  }, [added]);

  async function checkCanonical() {
    setChecking(true);
    await api.checkCanonical();
    setChecking(false);
  }

  const tabs: { id: MobileTab; label: string; count?: number }[] = [
    { id: 'original', label: 'Original' },
    { id: 'destinations', label: 'Destinations', count: added.length },
    { id: 'suggestions', label: 'Suggestions' },
  ];

  return (
    <div className="grid gap-4">
      <div role="tablist" aria-label="Sections" className="flex gap-1.5 md:hidden">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={mobileTab === t.id}
            onClick={() => setMobileTab(t.id)}
            className={cn('h-10 flex-1 rounded-lg border px-2 text-sm font-medium', mobileTab === t.id ? 'border-primary bg-accent text-accent-foreground' : 'border-border bg-surface text-muted-foreground')}
          >
            {t.label}
            {t.count ? <span className="ml-1 text-xs">({t.count})</span> : null}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className={cn('rounded-xl border bg-surface xl:max-h-[calc(100dvh-14rem)] xl:overflow-y-auto', mobileTab !== 'original' && 'hidden md:block')}>
          <OriginalPane articleId={articleId} title={article.title} html={html} jump={jump} />
        </div>

        <section aria-label="Destinations" className={cn('min-w-0 xl:max-h-[calc(100dvh-14rem)] xl:overflow-y-auto', mobileTab !== 'destinations' && 'hidden md:block')}>
          <div className="grid gap-3">
            <h2 className="text-sm font-semibold">Destinations</h2>
            {added.length === 0 ? (
              <p className="rounded-xl border p-4 text-sm leading-6 text-muted-foreground">
                Nothing chosen yet. Add a destination below, or use the{' '}
                <Link href={workspaceHref(articleId)} className="font-medium text-link underline underline-offset-2">
                  Publishing screen
                </Link>
                .
              </p>
            ) : (
              <ul ref={list} onKeyDown={onListKey} className="grid gap-3" aria-label="Chosen destinations">
                {added.map((d) => (
                  <DestinationCard key={d.platform} destination={d} api={api} onRun={run} onEdit={(el) => openDrawer(d.platform, 'edit', el)} />
                ))}
              </ul>
            )}

            <button
              type="button"
              aria-expanded={showOthers}
              onClick={() => setShowOthers((s) => !s)}
              className="flex h-10 items-center justify-between rounded-lg border bg-surface px-3 text-sm font-medium hover:bg-muted"
            >
              <span>{added.length === 0 ? 'All destinations' : 'Add another destination'}</span>
              <span className="text-xs text-muted-foreground">{others.length}</span>
            </button>
            {showOthers || added.length === 0 ? (
              <ul className="grid gap-3" aria-label="Other destinations">
                {others.map((d) => (
                  <DestinationCard key={d.platform} destination={d} api={api} onRun={run} onEdit={(el) => openDrawer(d.platform, 'edit', el)} />
                ))}
              </ul>
            ) : null}
          </div>
        </section>

        <div className={cn('rounded-xl border bg-surface md:col-span-2 xl:col-span-1 xl:max-h-[calc(100dvh-14rem)] xl:overflow-y-auto', mobileTab !== 'suggestions' && 'hidden md:block')}>
          <SuggestionsPane
            articleId={articleId}
            destinations={api.destinations}
            ai={ai}
            onJump={(quote) => {
              setMobileTab('original');
              setJump({ quote, nonce: Date.now() });
            }}
            onOpen={(platform) => openDrawer(platform, 'edit')}
            canonicalState={canonical}
            onCheckCanonical={() => void checkCanonical()}
            checkingCanonical={checking}
          />
        </div>
      </div>

      <div className="sticky bottom-0 z-20 -mx-4 flex items-center gap-3 border-t bg-background/95 px-4 py-3 md:hidden">
        <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{journey.next.why}</p>
        <Link href={journey.next.href} className={buttonVariants({ size: 'default' })}>
          {journey.next.label}
          <ArrowRight aria-hidden />
        </Link>
      </div>

      <DestinationDrawer destination={openDestination} api={api} article={article} ai={ai} facts={facts} tab={tab} onTab={setTab} onClose={closeDrawer} onApplied={() => void api.reload()} />
    </div>
  );
}

function DestinationCard({ destination: d, api, onRun, onEdit }: { destination: DestinationDTO; api: PublishApi; onRun(d: DestinationDTO, button: HTMLElement | null): void; onEdit(button: HTMLElement | null): void }) {
  const { action, hint } = cardAction(d);
  const entry = DIRECTORY.find((e) => e.composer === d.platform);
  const style = entry ? AREA_STYLE[entry.area] : null;
  const Icon = style?.icon;
  const busy = api.isBusy(d.platform);
  const errors = d.draft?.lint.filter((i) => i.severity === 'error').length ?? 0;
  const published = d.draft?.status === 'published';
  const id = `card-${d.platform}`;

  return (
    <li className={cn('rounded-xl border bg-surface p-3.5', d.added ? '' : '')} aria-labelledby={id}>
      <div className="flex items-start gap-3">
        {Icon ? (
          <span aria-hidden className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted', style?.text)}>
            <Icon className="size-4" />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span id={id} className="text-base leading-6 font-semibold">
              {d.info.name}
            </span>
            {d.added ? <StatusChip chip={draftChip(d.platform, d.draft)} /> : null}
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            {d.draft ? (d.draft.payload.title ? d.draft.payload.title : 'Untitled') : d.info.name}
            {d.draft?.account ? ` · ${d.draft.account}` : ''}
            {errors > 0 ? ` · ${errors} to fix` : ''}
          </p>
        </div>
      </div>
      <NoticeBar notice={api.notices[d.platform]} />
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{hint}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {action.kind === 'link' || action.kind === 'open' ? (
          <a
            data-card-action
            href={action.href}
            {...(action.kind === 'open' ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
            className={buttonVariants({ size: 'sm', variant: action.quiet ? 'outline' : 'default' })}
          >
            {action.label}
          </a>
        ) : (
          <Button data-card-action type="button" size="sm" variant={action.quiet ? 'outline' : 'default'} disabled={busy} onClick={(e) => onRun(d, e.currentTarget)}>
            {busy ? 'Working' : action.label}
          </Button>
        )}
        {d.added && d.draft ? (
          <Button type="button" size="sm" variant="ghost" onClick={(e) => onEdit(e.currentTarget)}>
            <Pencil aria-hidden />
            {published ? 'Details' : 'Edit'}
          </Button>
        ) : null}
        {d.added && !published && d.draft?.status !== 'publishing' && d.draft?.status !== 'unknown' ? (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void api.remove(d.platform)} aria-label={`Remove ${d.info.name} from this article`}>
            <Trash2 aria-hidden />
            Remove
          </Button>
        ) : null}
        {!d.added ? <Plus aria-hidden className="ml-auto size-4 text-muted-foreground" /> : null}
      </div>
    </li>
  );
}

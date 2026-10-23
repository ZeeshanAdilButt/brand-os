'use client';

import { ArrowRight, Maximize2, PictureInPicture2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EmptyState } from '@/components/brand/branch-art';
import { usePreviewExpand } from '@/components/publishing/previews/preview-context';
import { useViewPrefs } from '@/components/shell/view-prefs';
import { useShellLayout, useShellSteps } from '@/components/shell/shell-layout';
import { Button, buttonVariants } from '@/components/ui/button';
import { CollapsibleArea } from '@/components/ui/collapsible-area';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormNotice } from '@/components/ui/field';
import { api as http } from '@/lib/api-client';
import type { ArticleDTO } from '@/lib/articles';
import { RECOMMENDED_ORDER, type DestinationDTO, type PlatformId } from '@/lib/publishing';
import { journeySteps, selectorRows, type ArticleOption } from '@/lib/publish-workspace';
import { articleFacts, recommend } from '@/lib/recommend';
import { toggled, type PublishArea } from '@/lib/view-prefs';
import { loadRemembered, saveRemembered } from '@/lib/wizard-state';
import { cn } from '@/lib/utils';
import { usePublish, type PublishApi } from '../use-publish';
import { ArticlePicker } from './article-picker';
import { PlatformSelector } from './platform-selector';
import { PreviewArea, previewEntries } from './preview-area';
import { PreviewExpandProvider } from './preview-expand';
import { PreviewWindow } from './preview-window';

export interface WorkspaceArticle {
  id: string;
  title: string;
  description: string;
  tags: string[];
  canonicalUrl: string | null;
  bodyMarkdown: string;
}

const LAST_ARTICLE_KEY = 'brand-os.last-article';
const DESCRIPTION = 'Choose where it goes, and see how it will look. Nothing is sent from here. You approve every post yourself.';

/** The top of the page: a small label, the page's own title (the article's title once one is chosen) and the actions. */
function Header({ title, serif, actions, children }: { title: string; serif: boolean; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <p className="mono-label mb-2 text-muted-foreground">Publishing</p>
        <h1 data-testid={serif ? 'selected-article' : undefined} className={cn(serif ? 'font-serif text-3xl leading-9 font-semibold sm:text-[2rem] sm:leading-10' : 'text-3xl leading-9 font-bold sm:text-4xl sm:leading-10')}>
          {title}
        </h1>
        {serif ? null : <p className="mt-3 max-w-[64ch] text-[0.9375rem] leading-6 text-muted-foreground">Choose an article, then where it goes. You approve every post yourself.</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {children}
        {actions}
      </div>
    </header>
  );
}

/**
 * The one publishing screen. The page names the article and can change it. Left: where should it go, with suggestions,
 * category tabs and a plain list. Right: how it will look, a preview of each chosen platform. Choosing a platform
 * prepares its preview at once (nothing is sent) and unchoosing removes it. The choice is saved with the article, so it
 * is still there on the next visit. "Review and approve" continues into the approval queue, where every post is approved
 * on its own.
 */
export function PublishWorkspace({
  articles,
  initial,
  actions,
}: {
  articles: ArticleOption[];
  initial: { article: WorkspaceArticle | null; destinations: DestinationDTO[]; platform: PlatformId | null };
  /** Extra page actions, shown beside the article title. */
  actions?: ReactNode;
}) {
  const [articleId, setArticleId] = useState<string | null>(initial.article?.id ?? null);
  const [loaded, setLoaded] = useState<{ article: WorkspaceArticle; destinations: DestinationDTO[] } | null>(initial.article ? { article: initial.article, destinations: initial.destinations } : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);

  const choose = useCallback((id: string) => {
    setArticleId(id);
    setError(null);
    setLoading(true);
    const mine = ++token.current;
    void (async () => {
      const [a, d] = await Promise.all([http<ArticleDTO>(`/api/articles/${id}`), http<{ destinations: DestinationDTO[] }>(`/api/articles/${id}/destinations`)]);
      if (mine !== token.current) return;
      setLoading(false);
      if (!a.ok || !d.ok) {
        setError(!a.ok ? a.error : !d.ok ? d.error : 'Could not load this article.');
        return;
      }
      setLoaded({ article: { id, title: a.data.title, description: a.data.description, tags: a.data.tags, canonicalUrl: a.data.canonicalUrl, bodyMarkdown: a.data.bodyMarkdown }, destinations: d.data.destinations });
      try {
        window.localStorage.setItem(LAST_ARTICLE_KEY, id);
      } catch {
        /* not remembered */
      }
      const url = new URL(window.location.href);
      url.searchParams.set('article', id);
      url.searchParams.delete('platform');
      window.history.replaceState(window.history.state, '', url);
    })();
  }, []);

  if (loaded && loaded.article.id === articleId) {
    return (
      <WorkspaceBody
        key={loaded.article.id}
        articles={articles}
        article={loaded.article}
        destinations={loaded.destinations}
        initialPlatform={loaded.article.id === initial.article?.id ? initial.platform : null}
        onChooseArticle={choose}
        loading={loading}
        actions={actions}
      />
    );
  }
  return (
    <>
      <Header title="Publishing" serif={false} actions={actions} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <section aria-labelledby="choose-article" className="min-w-0 rounded-xl border bg-surface p-5">
          <h2 id="choose-article" className="mb-1 text-xl leading-7 font-semibold">
            Article
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">Choose the article to publish.</p>
          <ArticlePicker articles={articles} selectedId={articleId} onSelect={choose} />
          {loading ? <p className="mt-3 text-sm text-muted-foreground">Loading…</p> : null}
          {error ? (
            <div className="mt-3">
              <FormNotice tone="error">{error}</FormNotice>
            </div>
          ) : null}
        </section>
        <div className="hidden lg:block">
          <EmptyState title="Choose an article" branches={3}>
            Choose an article to see where it can go.
          </EmptyState>
        </div>
      </div>
    </>
  );
}

/** The footer chips: one for each preview that is ready. Each opens that preview large. */
function PreviewChips({ chosen, active }: { chosen: DestinationDTO[]; active: PlatformId | null }) {
  const expand = usePreviewExpand();
  const ready = chosen.filter((d) => d.draft);
  if (ready.length === 0) return null;
  return (
    <ul aria-label="Open a preview large" className="hidden flex-wrap items-center gap-2 sm:flex">
      {ready.map((d) => (
        <li key={d.platform}>
          <button
            type="button"
            aria-label={`Open ${d.info.name} preview large`}
            aria-haspopup="dialog"
            onClick={(e) => expand?.open(d.platform, e.currentTarget)}
            className={cn(
              'inline-flex h-10 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors duration-[120ms] hover:bg-secondary',
              active === d.platform ? 'border-border-strong bg-accent' : 'border-border bg-surface',
            )}
          >
            {d.info.name}
            <Maximize2 aria-hidden className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The floating window: the active platform's preview, in a window you can move, shrink, open large or close. */
function FloatingPreview({ api, articleId, chosen, active, onActive, onClose }: { api: PublishApi; articleId: string; chosen: DestinationDTO[]; active: PlatformId | null; onActive(platform: PlatformId): void; onClose(): void }) {
  const expand = usePreviewExpand();
  const [minimized, setMinimized] = useState(false);
  const current = chosen.find((d) => d.platform === active) ?? chosen[0] ?? null;
  const name = current?.info.name ?? 'Preview';
  return (
    <PreviewWindow
      title={`Preview · ${name}`}
      minimized={minimized}
      onToggleMinimized={() => setMinimized((m) => !m)}
      onExpand={(button) => current && expand?.open(current.platform, button)}
      onClose={onClose}
      expandLabel={`Open ${name} preview large`}
      className="hidden lg:flex"
    >
      <PreviewArea api={api} articleId={articleId} chosen={chosen} active={active} onActive={onActive} windowed />
    </PreviewWindow>
  );
}

function WorkspaceBody({
  articles,
  article,
  destinations,
  initialPlatform,
  onChooseArticle,
  loading,
  actions,
}: {
  articles: ArticleOption[];
  article: WorkspaceArticle;
  destinations: DestinationDTO[];
  initialPlatform: PlatformId | null;
  onChooseArticle(id: string): void;
  loading: boolean;
  actions?: ReactNode;
}) {
  const api: PublishApi = usePublish(article.id, destinations);
  const [active, setActive] = useState<PlatformId | null>(initialPlatform);
  const [remembered, setRemembered] = useState<PlatformId[]>([]);
  const [working, setWorking] = useState<ReadonlySet<PlatformId>>(new Set());
  const [changing, setChanging] = useState(false);
  const [floating, setFloating] = useState(false);
  const { prefs, update } = useViewPrefs();
  const [fullView, setFullView] = useState(false);
  // Full view gives the previews the whole window: the sidebar goes too, and comes back when it ends or the page is left.
  useShellLayout(true, fullView ? { hideSidebar: true, wide: true } : { fluid: true });
  const folded = useMemo(() => new Set(prefs.collapsedAreas), [prefs.collapsedAreas]);
  const previewsFolded = folded.has('previews') && !fullView;
  const platformsFolded = folded.has('platforms');
  const fold = (area: PublishArea, collapsed: boolean) => update({ collapsedAreas: toggled(prefs.collapsedAreas, area, collapsed) });
  // A floating window replaces the previews column; below the lg breakpoint there is no window, so the column stays.
  const detached = floating && !fullView;

  useEffect(() => {
    if (!fullView) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape that something else handled (a menu, the expanded preview) is not ours.
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      setFullView(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullView]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRemembered(loadRemembered(window.localStorage));
  }, []);

  const connected = useMemo(() => new Set(api.destinations.filter((d) => d.connection?.status === 'connected').map((d) => d.platform)), [api.destinations]);
  const rows = useMemo(() => selectorRows(connected), [connected]);
  const chosen = useMemo(() => api.destinations.filter((d) => d.added).sort((a, b) => RECOMMENDED_ORDER.indexOf(a.platform) - RECOMMENDED_ORDER.indexOf(b.platform)), [api.destinations]);
  const selected = useMemo(() => new Set(chosen.map((d) => d.platform)), [chosen]);
  const recommendations = useMemo(() => recommend(articleFacts(article), { connected, remembered }), [article, connected, remembered]);
  const entries = useMemo(() => previewEntries(chosen), [chosen]);
  const hasText = article.bodyMarkdown.trim().length > 0;
  const prepared = chosen.filter((d) => d.draft).length;
  const decided = chosen.filter((d) => d.draft && ['approved', 'publishing', 'published'].includes(d.draft.status)).length;
  const published = chosen.filter((d) => d.draft?.status === 'published').length;

  async function toggle(platform: PlatformId) {
    if (working.has(platform)) return;
    setWorking((w) => new Set(w).add(platform));
    const wasOn = selected.has(platform);
    if (wasOn) {
      await api.remove(platform);
      setActive((a) => (a === platform ? null : a));
    } else if (await api.add(platform)) {
      const result = await api.prepare(platform);
      if (result.ok) setActive(platform);
    }
    setWorking((w) => {
      const next = new Set(w);
      next.delete(platform);
      return next;
    });
    await api.reload();
  }

  async function chooseAll(platforms: PlatformId[]) {
    // One after another, so each preview appears as soon as it is ready and none can race another.
    for (const platform of platforms) if (!selected.has(platform)) await toggle(platform);
  }

  // The latest choice is remembered in this browser, so the next article starts from what you used last.
  const lastSaved = useRef('');
  useEffect(() => {
    const key = [...selected].sort().join(',');
    if (key === lastSaved.current || selected.size === 0) return;
    lastSaved.current = key;
    saveRemembered(window.localStorage, [...selected, ...loadRemembered(window.localStorage)]);
  }, [selected]);

  const steps = useMemo(() => journeySteps({ selected: chosen.length, prepared, decided, published }), [chosen.length, prepared, decided, published]);
  // The sidebar shows the steps on a wide screen; the strip below shows them on a narrow one.
  useShellSteps(steps);
  const stepNumber = Math.max(1, steps.findIndex((s) => s.state === 'current') + 1 || steps.length);
  const blockedReason = !hasText ? 'This article has no text yet.' : chosen.length === 0 ? 'Choose at least one platform.' : prepared < chosen.length || working.size > 0 ? 'Previews are still being prepared.' : null;
  const reviewHref = `/articles/${article.id}/publish?view=guided&step=3`;

  const leftOpen = 'lg:flex-[5_1_0%]';
  const rightOpen = 'lg:flex-[7_1_0%]';

  return (
    <PreviewExpandProvider entries={entries}>
      <Header title={article.title || 'Untitled article'} serif actions={actions}>
        <Button type="button" variant="outline" size="lg" aria-haspopup="dialog" onClick={() => setChanging(true)}>
          Change article
        </Button>
      </Header>

      <Dialog open={changing} onOpenChange={setChanging}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Choose an article</DialogTitle>
            <DialogDescription>Each article keeps its own platforms and previews.</DialogDescription>
          </DialogHeader>
          <ArticlePicker
            articles={articles}
            selectedId={article.id}
            listOnly
            onSelect={(id) => {
              setChanging(false);
              if (id !== article.id) onChooseArticle(id);
            }}
          />
        </DialogContent>
      </Dialog>

      <div className="mb-4 lg:hidden">
        <p className="mono-label text-muted-foreground">
          Step {stepNumber} of {steps.length}
          <span className="text-foreground"> · {steps[stepNumber - 1]?.label}</span>
        </p>
        <ol aria-label="Progress" className="mt-2 grid grid-cols-4 gap-1.5">
          {steps.map((s) => (
            <li key={s.id} aria-current={s.state === 'current' ? 'step' : undefined} className={cn('h-1.5 rounded-full', s.state === 'todo' ? 'bg-border' : s.state === 'current' ? 'bg-accent-warm' : 'bg-solid')}>
              <span className="sr-only">
                {s.label}: {s.state === 'done' ? 'done' : s.state === 'current' ? 'current' : 'not yet'}
              </span>
            </li>
          ))}
        </ol>
      </div>

      {!hasText ? <p className="mb-4 rounded-xl border border-info/25 bg-info-bg px-4 py-3 text-sm">This article has no text yet, so there is nothing to preview. Add some in the studio first.</p> : null}
      {api.loadError ? (
        <div className="mb-4">
          <FormNotice tone="error">{api.loadError}</FormNotice>
        </div>
      ) : null}

      <div className={cn('flex flex-col gap-6 lg:flex-row lg:items-start', loading && 'opacity-60')} aria-busy={loading}>
        <div className={cn('min-w-0', fullView && 'hidden', platformsFolded ? 'lg:w-12 lg:shrink-0' : detached ? 'lg:max-w-3xl lg:flex-1' : leftOpen)}>
          <CollapsibleArea
            title="Platforms"
            heading="Where should it go?"
            summary={`${chosen.length} ${chosen.length === 1 ? 'platform' : 'platforms'} selected`}
            note="Tick any. Each one gets its own preview. Nothing is sent from here."
            collapsed={platformsFolded}
            onCollapsedChange={(c) => fold('platforms', c)}
          >
            <PlatformSelector rows={rows} selected={selected} busy={working} onToggle={(p) => void toggle(p)} onChooseAll={(list) => void chooseAll(list)} recommendations={recommendations} />
          </CollapsibleArea>
        </div>
        <div className={cn('min-w-0', detached && 'lg:hidden', previewsFolded ? 'lg:w-12 lg:shrink-0' : cn('lg:min-w-0', fullView ? 'lg:flex-1' : rightOpen))}>
          <CollapsibleArea
            title="Previews"
            heading="How it will look"
            summary={chosen.length === 0 ? 'Nothing to preview yet' : `${prepared} of ${chosen.length} ready`}
            side="right"
            collapsed={previewsFolded}
            onCollapsedChange={(c) => fold('previews', c)}
            canCollapse={!fullView}
            actions={
              <>
                {fullView ? <span className="hidden self-center text-xs text-muted-foreground sm:inline">Esc to leave</span> : null}
                <Button type="button" size="sm" variant="outline" className="hidden lg:inline-flex" onClick={() => setFloating(true)} title="Show the preview in a floating window you can move">
                  <PictureInPicture2 aria-hidden />
                  Float
                </Button>
                <Button type="button" size="sm" variant={fullView ? 'default' : 'outline'} aria-pressed={fullView} onClick={() => setFullView((v) => !v)} title="Hide the sidebar and the platform list so the previews use the whole width">
                  <Maximize2 aria-hidden />
                  Full view
                </Button>
              </>
            }
          >
            <PreviewArea api={api} articleId={article.id} chosen={chosen} active={active} onActive={setActive} />
          </CollapsibleArea>
        </div>
      </div>

      {detached ? <FloatingPreview api={api} articleId={article.id} chosen={chosen} active={active} onActive={setActive} onClose={() => setFloating(false)} /> : null}

      <div
        className={cn(
          'sticky bottom-0 z-20 mt-6 flex flex-wrap items-center gap-x-4 gap-y-3 border-t-[1.5px] border-border-strong bg-surface py-3',
          // The bar reaches the page edges: it undoes the padding of the page column it sits in (narrower in full view).
          fullView ? '-mx-2 px-2 sm:-mx-4 sm:px-4' : '-mx-5 px-5 sm:-mx-8 sm:px-8 lg:-mx-10 lg:px-10',
        )}
      >
        <PreviewChips chosen={chosen} active={active} />
        <p className="min-w-0 flex-1 text-sm" aria-live="polite">
          <span className="font-semibold">
            {chosen.length} {chosen.length === 1 ? 'platform' : 'platforms'} selected
          </span>
          <span className="text-muted-foreground"> · {blockedReason ?? 'Nothing is sent. Each post is approved on its own, with its exact text in front of you.'}</span>
        </p>
        {blockedReason ? (
          <button type="button" disabled title={blockedReason} className={cn(buttonVariants({ size: 'lg' }), 'h-12')}>
            Review and approve
            <ArrowRight aria-hidden />
          </button>
        ) : (
          <Link href={reviewHref} className={cn(buttonVariants({ size: 'lg' }), 'h-12')}>
            Review and approve
            <ArrowRight aria-hidden />
          </Link>
        )}
      </div>
    </PreviewExpandProvider>
  );
}

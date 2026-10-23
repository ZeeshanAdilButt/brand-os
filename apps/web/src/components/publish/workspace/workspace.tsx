'use client';

import { ArrowRight, Maximize2, PanelLeftClose, PictureInPicture2, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EmptyState } from '@/components/brand/branch-art';
import { PreviewViewContext, usePreviewExpand, type PreviewView } from '@/components/publishing/previews/preview-context';
import { ViewSection } from '@/components/publishing/previews/preview-frame';
import { useViewPrefs } from '@/components/shell/view-prefs';
import { useShellLayout, useShellSteps } from '@/components/shell/shell-layout';
import { Button, buttonVariants } from '@/components/ui/button';
import { PopoverClose } from '@/components/ui/popover';
import { CollapsibleArea } from '@/components/ui/collapsible-area';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormNotice } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { api as http } from '@/lib/api-client';
import type { ArticleDTO } from '@/lib/articles';
import { RECOMMENDED_ORDER, type DestinationDTO, type PlatformId } from '@/lib/publishing';
import { journeySteps, selectorRows, type ArticleOption } from '@/lib/publish-workspace';
import { articleFacts, recommend } from '@/lib/recommend';
import { toggled } from '@/lib/view-prefs';
import { loadRemembered, saveRemembered } from '@/lib/wizard-state';
import { cn } from '@/lib/utils';
import { usePublish, type PublishApi } from '../use-publish';
import { ArticlePicker } from './article-picker';
import { PlatformSelector } from './platform-selector';
import { LayoutAndSize, PreviewArea, previewEntries } from './preview-area';
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

/** One slim line: a small label, the page's own title (the article's title once one is chosen) and the actions. */
function Header({ title, serif, children }: { title: string; serif: boolean; children?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="flex min-w-[12rem] flex-1 basis-0 flex-col sm:flex-row sm:items-baseline sm:gap-3">
        <p className="mono-label shrink-0 text-muted-foreground">Publishing</p>
        <h1 title={title} data-testid={serif ? 'selected-article' : undefined} className={cn('min-w-0 line-clamp-2 break-words sm:line-clamp-1', serif ? 'font-serif text-2xl leading-9 font-semibold' : 'text-2xl leading-9 font-bold')}>
          {title}
        </h1>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </header>
  );
}

/**
 * The one publishing screen. The page names the article and can change it. Left: where should it go, a plain list of
 * platforms. Right: how it will look, a preview of each chosen platform with its checks and one View panel. Choosing a
 * platform prepares its preview at once (nothing is sent) and unchoosing removes it. The choice is saved with the
 * article, so it is still there on the next visit. "Review" continues into the approval queue, where every post is
 * approved on its own.
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
      <Header title="Publishing" serif={false}>
        {actions}
      </Header>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <section aria-labelledby="choose-article" className="min-w-0 rounded-xl border bg-surface p-5">
          <h2 id="choose-article" className="mb-4 text-xl leading-7 font-semibold">
            Choose an article
          </h2>
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

/** The workspace's part of the View panel: how the previews are laid out and sized, and the ways to give them more room. */
function WorkspaceViewMenu({
  windowed,
  ready,
  floating,
  onFloat,
  fullView,
  onFullView,
  platformsFolded,
  onFoldPlatforms,
}: {
  windowed: boolean;
  ready: number;
  floating: boolean;
  onFloat(on: boolean): void;
  fullView: boolean;
  onFullView(on: boolean): void;
  platformsFolded: boolean;
  onFoldPlatforms(folded: boolean): void;
}) {
  return (
    <>
      {windowed ? null : <LayoutAndSize ready={ready} />}
      <ViewSection title="Room">
        {/* The panel closes when the preview moves, because the control it hangs from is about to go. */}
        {floating ? (
          <PopoverClose asChild>
            <Button type="button" variant="outline" className="hidden lg:inline-flex" onClick={() => onFloat(false)}>
              <X aria-hidden />
              Dock the preview
            </Button>
          </PopoverClose>
        ) : (
          <PopoverClose asChild>
            <Button type="button" variant="outline" className="hidden lg:inline-flex" onClick={() => onFloat(true)} title="Show the preview in a floating window you can move">
              <PictureInPicture2 aria-hidden />
              Float window
            </Button>
          </PopoverClose>
        )}
        <Button type="button" variant={fullView ? 'default' : 'outline'} aria-pressed={fullView} onClick={() => onFullView(!fullView)} title="Hide the sidebar and the platform list so the previews use the whole width. Esc leaves it.">
          <Maximize2 aria-hidden />
          Full view
        </Button>
        {windowed || fullView ? null : (
          <Button type="button" variant="outline" className="hidden lg:inline-flex" aria-pressed={platformsFolded} onClick={() => onFoldPlatforms(!platformsFolded)}>
            <PanelLeftClose aria-hidden />
            {platformsFolded ? 'Show platform list' : 'Hide platform list'}
          </Button>
        )}
      </ViewSection>
    </>
  );
}

/** The floating window: the active platform's preview, in a window you can move, shrink, open large or close. */
function FloatingPreview({
  api,
  articleId,
  chosen,
  active,
  onActive,
  onClose,
  view,
}: {
  api: PublishApi;
  articleId: string;
  chosen: DestinationDTO[];
  active: PlatformId | null;
  onActive(platform: PlatformId): void;
  onClose(): void;
  view: PreviewView;
}) {
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
      <PreviewViewContext.Provider value={{ ...view, hideExpand: true }}>
        <PreviewArea api={api} articleId={articleId} chosen={chosen} active={active} onActive={onActive} windowed />
      </PreviewViewContext.Provider>
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
  const [mobileView, setMobileView] = useState<'platforms' | 'preview'>('platforms');
  const { prefs, update } = useViewPrefs();
  const [fullView, setFullView] = useState(false);
  // Full view gives the previews the whole window: the sidebar goes too, and comes back when it ends or the page is left.
  useShellLayout(true, fullView ? { hideSidebar: true, wide: true } : { fluid: true });
  const platformsFolded = prefs.collapsedAreas.includes('platforms') && !fullView;
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
  // The suggestions are for a first visit: nothing chosen and nothing connected yet.
  const firstRun = chosen.length === 0 && connected.size === 0;

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
  // The sidebar shows the steps (the drawer on a phone).
  useShellSteps(steps);
  const blockedReason = !hasText ? 'This article has no text yet.' : chosen.length === 0 ? 'Choose at least one platform.' : prepared < chosen.length || working.size > 0 ? 'Previews are still being prepared.' : null;
  const reviewHref = `/articles/${article.id}/publish?view=guided&step=3`;
  const reviewLabel = chosen.length === 0 ? 'Choose a platform' : `Review ${chosen.length} ${chosen.length === 1 ? 'post' : 'posts'}`;

  const foldPlatforms = (folded: boolean) => update({ collapsedAreas: toggled(prefs.collapsedAreas, 'platforms', folded) });
  const menu = (windowed: boolean) => (
    <WorkspaceViewMenu windowed={windowed} ready={entries.length} floating={floating} onFloat={setFloating} fullView={fullView} onFullView={setFullView} platformsFolded={platformsFolded} onFoldPlatforms={foldPlatforms} />
  );
  const view = (windowed: boolean): PreviewView => ({
    device: prefs.previewDevice,
    onDevice: (previewDevice) => update({ previewDevice }),
    appearance: prefs.previewAppearance,
    onAppearance: (previewAppearance) => update({ previewAppearance }),
    menu: menu(windowed),
  });

  // Each column scrolls on its own on a wide screen, so the page itself holds still.
  const columnHeight = 'lg:max-h-[calc(100dvh-16rem)] lg:overflow-y-auto lg:overscroll-contain';

  return (
    <PreviewExpandProvider entries={entries}>
      <Header title={article.title || 'Untitled article'} serif>
        {fullView ? (
          <Button type="button" variant="default" size="lg" onClick={() => setFullView(false)}>
            Leave full view
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="lg" aria-haspopup="dialog" aria-label="Change article" onClick={() => setChanging(true)}>
          <span className="sm:hidden">Change</span>
          <span className="hidden sm:inline">Change article</span>
        </Button>
        {actions}
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

      <div className="sticky top-16 z-10 -mx-5 mb-4 bg-background px-5 py-2 sm:-mx-8 sm:px-8 lg:hidden">
        <Segmented<'platforms' | 'preview'>
          label="Show"
          columns={2}
          value={mobileView}
          onChange={setMobileView}
          options={[
            { value: 'platforms', label: `Platforms${chosen.length > 0 ? ` (${chosen.length})` : ''}` },
            { value: 'preview', label: 'Preview' },
          ]}
        />
      </div>

      {!hasText ? <p className="mb-4 rounded-xl border border-info/25 bg-info-bg px-4 py-3 text-sm">This article has no text yet, so there is nothing to preview. Add some in the studio first.</p> : null}
      {api.loadError ? (
        <div className="mb-4">
          <FormNotice tone="error">{api.loadError}</FormNotice>
        </div>
      ) : null}

      <div className={cn('flex flex-col gap-6 lg:flex-row lg:items-start', loading && 'opacity-60')} aria-busy={loading}>
        <div className={cn('min-w-0', fullView && 'hidden', mobileView !== 'platforms' && 'max-lg:hidden', platformsFolded ? 'lg:w-12 lg:shrink-0' : cn(columnHeight, detached ? 'lg:max-w-3xl lg:flex-1' : 'lg:min-w-[24rem] lg:flex-[5_1_0%]'))}>
          <CollapsibleArea
            title="Platforms"
            heading="Where should it go?"
            summary={`${chosen.length} ${chosen.length === 1 ? 'platform' : 'platforms'} selected`}
            actions={
              <span className="self-center text-sm text-muted-foreground" aria-live="polite">
                {chosen.length} selected
              </span>
            }
            collapsed={platformsFolded}
            onCollapsedChange={foldPlatforms}
            canCollapse={false}
          >
            <PlatformSelector rows={rows} selected={selected} busy={working} onToggle={(p) => void toggle(p)} onChooseAll={(list) => void chooseAll(list)} recommendations={firstRun ? recommendations : []} />
          </CollapsibleArea>
        </div>
        <section aria-labelledby="how-it-looks" className={cn('min-w-0', mobileView !== 'preview' && 'max-lg:hidden', detached ? 'lg:hidden' : cn(columnHeight, fullView ? 'lg:flex-1' : 'lg:flex-[7_1_0%]'))}>
          <h2 id="how-it-looks" className="sr-only">
            How it will look
          </h2>
          <PreviewViewContext.Provider value={view(false)}>
            <PreviewArea api={api} articleId={article.id} chosen={chosen} active={active} onActive={setActive} />
          </PreviewViewContext.Provider>
        </section>
      </div>

      {detached ? <FloatingPreview api={api} articleId={article.id} chosen={chosen} active={active} onActive={setActive} onClose={() => setFloating(false)} view={view(true)} /> : null}

      <div
        className={cn(
          'sticky bottom-0 z-20 mt-6 flex flex-wrap items-center gap-x-4 gap-y-3 border-t-[1.5px] border-border-strong bg-surface py-3',
          // The bar reaches the page edges: it undoes the padding of the page column it sits in (narrower in full view).
          fullView ? '-mx-2 px-2 sm:-mx-4 sm:px-4' : '-mx-5 px-5 sm:-mx-8 sm:px-8 lg:-mx-10 lg:px-10',
        )}
      >
        <p className={cn('min-w-0 flex-1 text-sm text-muted-foreground', !(chosen.length > 0 && blockedReason) && 'hidden sm:block')}>{chosen.length > 0 && blockedReason ? blockedReason : 'You approve each post on its own, with its exact text in front of you.'}</p>
        {blockedReason ? (
          <button type="button" disabled title={blockedReason} className={cn(buttonVariants({ size: 'lg' }), 'w-full sm:w-auto')}>
            {reviewLabel}
            <ArrowRight aria-hidden />
          </button>
        ) : (
          <Link href={reviewHref} className={cn(buttonVariants({ size: 'lg' }), 'w-full sm:w-auto')}>
            {reviewLabel}
            <ArrowRight aria-hidden />
          </Link>
        )}
      </div>
    </PreviewExpandProvider>
  );
}

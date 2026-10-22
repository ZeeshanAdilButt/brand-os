'use client';

import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { FormNotice } from '@/components/ui/field';
import { api as http } from '@/lib/api-client';
import type { ArticleDTO } from '@/lib/articles';
import { RECOMMENDED_ORDER, type DestinationDTO, type PlatformId } from '@/lib/publishing';
import { selectorRows, workspaceProgress, type ArticleOption } from '@/lib/publish-workspace';
import { articleFacts, recommend } from '@/lib/recommend';
import { loadRemembered, saveRemembered } from '@/lib/wizard-state';
import { cn } from '@/lib/utils';
import { usePublish, type PublishApi } from '../use-publish';
import { ArticlePicker } from './article-picker';
import { PlatformSelector } from './platform-selector';
import { PreviewArea } from './preview-area';

export interface WorkspaceArticle {
  id: string;
  title: string;
  description: string;
  tags: string[];
  canonicalUrl: string | null;
  bodyMarkdown: string;
}

const LAST_ARTICLE_KEY = 'brand-os.last-article';

function Area({ n, title, note, children, className }: { n: number; title: string; note?: string; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={`area-${n}`} className={cn('min-w-0 rounded-xl border bg-surface p-4 sm:p-5', className)}>
      <h2 id={`area-${n}`} className="flex items-center gap-2.5 text-lg font-semibold">
        <span aria-hidden className="grid size-6 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {n}
        </span>
        {title}
      </h2>
      {note ? <p className="mt-1 mb-3 text-sm text-muted-foreground">{note}</p> : <div className="mb-3" />}
      {children}
    </section>
  );
}

/**
 * The one publishing screen: choose the article, choose platforms, see a preview of each, all on one page. Choosing a
 * platform prepares its preview at once (nothing is sent) and unchoosing removes it. The choice is saved with the
 * article, so it is still there on the next visit. "Review and approve" continues into the approval queue, where every
 * post is approved on its own.
 */
export function PublishWorkspace({
  articles,
  initial,
}: {
  articles: ArticleOption[];
  initial: { article: WorkspaceArticle | null; destinations: DestinationDTO[]; platform: PlatformId | null };
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

  return (
    <div className="grid gap-4">
      {loaded && loaded.article.id === articleId ? (
        <WorkspaceBody key={loaded.article.id} articles={articles} article={loaded.article} destinations={loaded.destinations} initialPlatform={loaded.article.id === initial.article?.id ? initial.platform : null} onChooseArticle={choose} loading={loading} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <Area n={1} title="Article" note="Choose the article to publish.">
            <ArticlePicker articles={articles} selectedId={articleId} onSelect={choose} />
            {loading ? <p className="mt-3 text-sm text-muted-foreground">Loading…</p> : null}
            {error ? <div className="mt-3"><FormNotice tone="error">{error}</FormNotice></div> : null}
          </Area>
          <div className="hidden rounded-xl border bg-surface p-8 text-center text-sm text-muted-foreground lg:block">Choose an article to see where it can go.</div>
        </div>
      )}
    </div>
  );
}

function WorkspaceBody({
  articles,
  article,
  destinations,
  initialPlatform,
  onChooseArticle,
  loading,
}: {
  articles: ArticleOption[];
  article: WorkspaceArticle;
  destinations: DestinationDTO[];
  initialPlatform: PlatformId | null;
  onChooseArticle(id: string): void;
  loading: boolean;
}) {
  const api: PublishApi = usePublish(article.id, destinations);
  const [active, setActive] = useState<PlatformId | null>(initialPlatform);
  const [remembered, setRemembered] = useState<PlatformId[]>([]);
  const [working, setWorking] = useState<ReadonlySet<PlatformId>>(new Set());

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRemembered(loadRemembered(window.localStorage));
  }, []);

  const connected = useMemo(() => new Set(api.destinations.filter((d) => d.connection?.status === 'connected').map((d) => d.platform)), [api.destinations]);
  const rows = useMemo(() => selectorRows(connected), [connected]);
  const chosen = useMemo(() => api.destinations.filter((d) => d.added).sort((a, b) => RECOMMENDED_ORDER.indexOf(a.platform) - RECOMMENDED_ORDER.indexOf(b.platform)), [api.destinations]);
  const selected = useMemo(() => new Set(chosen.map((d) => d.platform)), [chosen]);
  const recommendations = useMemo(() => recommend(articleFacts(article), { connected, remembered }), [article, connected, remembered]);
  const hasText = article.bodyMarkdown.trim().length > 0;
  const prepared = chosen.filter((d) => d.draft).length;

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

  const progress = workspaceProgress({ hasArticle: true, selected: chosen.length, prepared });
  const blockedReason = !hasText ? 'This article has no text yet.' : chosen.length === 0 ? 'Choose at least one platform.' : prepared < chosen.length || working.size > 0 ? 'Previews are still being prepared.' : null;
  const reviewHref = `/articles/${article.id}/publish?view=guided&step=3`;

  return (
    <>
      <ol aria-label="Progress" className="flex gap-2 lg:hidden">
        {progress.map((p, i) => (
          <li key={p.id} aria-current={p.state === 'current' ? 'step' : undefined} className={cn('flex flex-1 items-center gap-2 rounded-lg border px-2.5 py-2 text-sm', p.state === 'current' ? 'border-primary bg-accent font-semibold' : 'bg-surface text-muted-foreground')}>
            <span aria-hidden className={cn('grid size-5 shrink-0 place-items-center rounded-full text-xs font-semibold', p.state === 'done' ? 'bg-success text-surface' : p.state === 'current' ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
              {p.state === 'done' ? <Check className="size-3" /> : i + 1}
            </span>
            {p.label}
          </li>
        ))}
      </ol>

      {!hasText ? <p className="rounded-lg border border-info/25 bg-info-bg px-3 py-2 text-sm">This article has no text yet, so there is nothing to preview. Add some in the studio first.</p> : null}
      {api.loadError ? <FormNotice tone="error">{api.loadError}</FormNotice> : null}

      <div className={cn('grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]', loading && 'opacity-60')} aria-busy={loading}>
        <div className="grid min-w-0 content-start gap-4">
          <Area n={1} title="Article" note="The article every preview is built from.">
            <ArticlePicker articles={articles} selectedId={article.id} onSelect={onChooseArticle} />
          </Area>
          <Area n={2} title="Platforms" note="Tick as many as you like. Each gets a preview at once. Nothing is sent.">
            <PlatformSelector rows={rows} selected={selected} busy={working} onToggle={(p) => void toggle(p)} onChooseAll={(list) => void chooseAll(list)} recommendations={recommendations} />
          </Area>
        </div>
        <Area n={3} title="Previews" note="An approximate preview of this article on each platform you chose.">
          <PreviewArea api={api} articleId={article.id} chosen={chosen} active={active} onActive={setActive} />
        </Area>
      </div>

      <div className="sticky bottom-0 z-20 -mx-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-surface px-5 py-3 shadow-md sm:-mx-8 sm:px-8 lg:-mx-10 lg:px-10">
        <p className="min-w-0 flex-1 text-sm" aria-live="polite">
          <span className="font-semibold">
            {chosen.length} {chosen.length === 1 ? 'platform' : 'platforms'} selected
          </span>
          <span className="text-muted-foreground"> · {blockedReason ?? 'Each post is approved one at a time, on its own.'}</span>
        </p>
        {blockedReason ? (
          <button type="button" disabled title={blockedReason} className={buttonVariants({ size: 'lg' })}>
            Review and approve
            <ArrowRight aria-hidden />
          </button>
        ) : (
          <Link href={reviewHref} className={buttonVariants({ size: 'lg' })}>
            Review and approve
            <ArrowRight aria-hidden />
          </Link>
        )}
      </div>
    </>
  );
}

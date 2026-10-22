'use client';

import { LayoutPanelLeft, ListChecks } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useArticleTasks } from '@/components/ai/use-task-stream';
import { NextStepBar } from '@/components/guided/next-step-bar';
import { Segmented } from '@/components/ui/segmented';
import { FormNotice } from '@/components/ui/field';
import type { PlatformId } from '@/lib/catalog';
import type { DestinationDTO } from '@/lib/publishing';
import { recommend, type ArticleFacts } from '@/lib/recommend';
import { loadRemembered, type WizardStep } from '@/lib/wizard-state';
import type { AiState } from './ai-assist';
import type { SiteFacts } from './approval-review';
import { Composer } from './composer';
import { GuidedWizard } from './guided-wizard';
import { usePublish } from './use-publish';

import type { PublishView } from '@/lib/publish-address';
const VIEW_KEY = 'brand-os.publish-view';

/**
 * The publishing screen for one article. Two views of the same data: the guided steps (the default, for a first
 * publish) and the composer (everything side by side). Which one you use is remembered in this browser, and the
 * address says where you are (view, step, destination) so a reload or a shared link lands in the same place.
 */
export function PublishScreen({
  articleId,
  article,
  html,
  destinations,
  facts,
  articleFacts,
  aiAvailable,
  revision,
  initial,
}: {
  articleId: string;
  article: { title: string; body: string };
  html: string;
  destinations: DestinationDTO[];
  facts: SiteFacts;
  articleFacts: ArticleFacts;
  aiAvailable: boolean;
  revision: number;
  initial: { view: PublishView | null; step: WizardStep | null; focus: PlatformId | null };
}) {
  const api = usePublish(articleId, destinations);
  const tasks = useArticleTasks(articleId);
  const [view, setViewState] = useState<PublishView>(initial.view ?? 'guided');
  const [remembered, setRemembered] = useState<PlatformId[]>([]);

  // The remembered view applies only when the address did not choose one.
  useEffect(() => {
    if (initial.view !== null || initial.step !== null) return;
    try {
      const saved = window.localStorage.getItem(VIEW_KEY);
      // The remembered view is only known in the browser, so it is applied after hydration.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved === 'composer') setViewState('composer');
    } catch {
      /* private mode: the default stays */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRemembered(loadRemembered(window.localStorage));
  }, []);

  const setQuery = useCallback((changes: Record<string, string | null>) => {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    window.history.replaceState(window.history.state, '', url);
  }, []);

  function setView(next: PublishView) {
    setViewState(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* not remembered */
    }
    setQuery({ view: next, step: null, d: null });
  }

  const ai: AiState = useMemo(
    () => ({ available: aiAvailable, tasks: tasks.tasks, revision, reload: tasks.reload, merge: tasks.merge }),
    [aiAvailable, tasks.tasks, revision, tasks.reload, tasks.merge],
  );

  const connected = useMemo(() => new Set(api.destinations.filter((d) => d.connection?.status === 'connected').map((d) => d.platform)), [api.destinations]);
  const recommendations = useMemo(() => recommend(articleFacts, { connected, remembered }), [articleFacts, connected, remembered]);
  const hasText = article.body.trim().length > 0;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <NextStepBarWrap articleId={articleId} title={article.title} hasText={hasText} destinations={api.destinations} />
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'guided', label: (<><ListChecks aria-hidden className="size-4" />Guided</>), title: 'Four steps, one at a time' },
            { value: 'composer', label: (<><LayoutPanelLeft aria-hidden className="size-4" />Composer</>), title: 'Everything side by side' },
          ]}
        />
      </div>

      {api.loadError ? <FormNotice tone="error">{api.loadError}</FormNotice> : null}
      {!hasText ? <p className="rounded-lg border border-info/25 bg-info-subtle px-3 py-2 text-sm">This article has no text yet, so there is nothing to publish. Add some in the studio first.</p> : null}

      {view === 'guided' ? (
        <GuidedWizard
          api={api}
          articleId={articleId}
          article={article}
          facts={facts}
          ai={ai}
          recommendations={recommendations}
          initialStep={initial.step}
          initialFocus={initial.focus}
          onChangeStep={(step) => setQuery({ view: 'guided', step: String(step) })}
        />
      ) : (
        <Composer
          api={api}
          articleId={articleId}
          article={article}
          html={html}
          facts={facts}
          ai={ai}
          initialFocus={initial.focus}
          onFocusChange={(platform) => setQuery({ view: 'composer', d: platform })}
        />
      )}
    </div>
  );
}

function NextStepBarWrap({ articleId, title, hasText, destinations }: { articleId: string; title: string; hasText: boolean; destinations: DestinationDTO[] }) {
  return (
    <div className="min-w-0 flex-1 basis-80">
      <NextStepBar articleId={articleId} title={title} hasText={hasText} destinations={destinations} />
    </div>
  );
}


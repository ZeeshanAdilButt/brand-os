'use client';

import { ArrowLeft, BookOpen, Columns2, Eye, History, PenLine, Save, SlidersHorizontal, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, sendSave, toDraft } from '@/lib/api-client';
import { countWords, readingMinutes, slugify, SLUG_PATTERN, STATUS_LABELS, type ArticleDTO, type AssetDTO } from '@/lib/articles';
import { SaveController, type ControllerStatus, type Draft } from '@/lib/autosave';
import { cn } from '@/lib/utils';
import { ConflictDialog } from './conflict-dialog';
import { HistoryPanel } from './history-panel';
import type { EditorHandle, UploadOutcome } from './markdown-editor';
import { MetadataPanel, type SlugView } from './metadata-panel';
import { PreviewPane } from './preview-pane';
import { SaveIndicator } from './save-indicator';

function EditorSkeleton() {
  return (
    <div className="grid h-full content-start gap-3 bg-card p-4" aria-busy="true" aria-label="Loading the editor">
      {[88, 64, 92, 40, 76, 58, 84].map((width, i) => (
        <div key={i} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

// The editor and its language support are the heaviest code on the page, so they load on demand.
const MarkdownEditor = dynamic(() => import('./markdown-editor').then((m) => m.MarkdownEditor), { ssr: false, loading: () => <EditorSkeleton /> });

type Mode = 'edit' | 'split' | 'preview';
type Panel = 'details' | 'history' | null;

const isWide = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;

const modeButton = (active: boolean) =>
  cn(
    'inline-flex h-8 items-center gap-1.5 px-3 text-sm font-medium transition-colors first:rounded-l-md last:rounded-r-md',
    active ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
  );

export function Studio({ initial }: { initial: ArticleDTO }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const draftRef = useRef(draft);
  const editor = useRef<EditorHandle>(null);
  const previewScroll = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ControllerStatus | null>(null);
  const [mode, setMode] = useState<Mode>(() => (isWide() ? 'split' : 'edit'));
  const [panel, setPanel] = useState<Panel>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [slug, setSlug] = useState<SlugView>({
    value: initial.slug,
    state: 'idle',
    message: null,
    suggestion: null,
    auto: initial.title === '' && /^untitled(-\d+)?$/.test(initial.slug),
  });
  const slugAuto = useRef(slug.auto);
  const slugTimer = useRef<number | null>(null);
  const slugToken = useRef(0);

  // One controller for the life of the editor; it holds the save queue and survives re-renders.
  const [controller] = useState(
    () =>
      new SaveController({
        initial: { draft: toDraft(initial), revision: initial.revision },
        send: (request) => sendSave(initial.id, request),
        onChange: (next) => setStatus(next),
      }),
  );
  const state = status ?? controller.getStatus();

  const edit = useCallback(
    (patch: Partial<Draft>) => {
      const next = { ...draftRef.current, ...patch };
      draftRef.current = next;
      setDraft(next);
      controller.edit(next);
    },
    [controller],
  );

  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 9000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /* ---- slug: follows the title for a new article, otherwise checked as the person types ---- */

  const resolveSlug = useCallback(
    async (candidate: string, options: { auto: boolean; adoptSuggestion: boolean }) => {
      const token = ++slugToken.current;
      if (!SLUG_PATTERN.test(candidate) || candidate.length > 100) {
        setSlug((s) => ({ ...s, value: candidate, state: 'invalid', message: 'Use lower-case letters, numbers and single hyphens only.', suggestion: null, auto: options.auto }));
        return;
      }
      setSlug((s) => ({ ...s, value: candidate, state: 'checking', message: null, auto: options.auto }));
      const result = await api<{ valid: boolean; available: boolean; message: string | null; suggestion: string | null }>(
        `/api/articles/check-slug?slug=${encodeURIComponent(candidate)}&exclude=${initial.id}`,
      );
      if (token !== slugToken.current) return;
      if (!result.ok) {
        setSlug((s) => ({ ...s, state: 'idle', message: 'Could not check this slug right now. It will be checked again when you save.' }));
        return;
      }
      if (result.data.available) {
        setSlug({ value: candidate, state: 'available', message: null, suggestion: null, auto: options.auto });
        if (candidate !== draftRef.current.slug) edit({ slug: candidate });
        return;
      }
      if (options.adoptSuggestion && result.data.suggestion) {
        setSlug({ value: result.data.suggestion, state: 'available', message: null, suggestion: null, auto: options.auto });
        if (result.data.suggestion !== draftRef.current.slug) edit({ slug: result.data.suggestion });
        return;
      }
      setSlug({ value: candidate, state: 'taken', message: 'Another article of yours already uses this slug.', suggestion: result.data.suggestion, auto: options.auto });
    },
    [edit, initial.id],
  );

  const scheduleSlug = useCallback(
    (candidate: string, options: { auto: boolean; adoptSuggestion: boolean }, delay = 450) => {
      if (slugTimer.current) window.clearTimeout(slugTimer.current);
      slugTimer.current = window.setTimeout(() => void resolveSlug(candidate, options), delay);
    },
    [resolveSlug],
  );

  function onTitle(title: string) {
    edit({ title });
    if (slugAuto.current) scheduleSlug(slugify(title), { auto: true, adoptSuggestion: true });
  }

  function onSlugInput(raw: string) {
    const value = raw.toLowerCase().replace(/\s+/g, '-');
    slugAuto.current = false;
    setSlug((s) => ({ ...s, value, auto: false }));
    scheduleSlug(value, { auto: false, adoptSuggestion: false });
  }

  /* ---- bring the whole editor to a server copy (restore, or taking the other version) ---- */

  const showCopy = useCallback((copy: Draft) => {
    draftRef.current = copy;
    setDraft(copy);
    editor.current?.setValue(copy.bodyMarkdown);
    slugToken.current += 1;
    setSlug((s) => ({ ...s, value: copy.slug, state: 'idle', message: null, suggestion: null }));
  }, []);

  /* ---- saving ---- */

  const saveNow = useCallback(() => void controller.saveNow(), [controller]);

  useEffect(() => {
    const flush = () => void controller.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const s = controller.getStatus().state;
      if (s === 'dirty' || s === 'saving' || s === 'error' || s === 'offline' || s === 'conflict') {
        flush();
        event.preventDefault();
      }
    };
    const onOnline = () => void controller.retryNow();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('online', onOnline);
      // Leaving through a link inside the app: send anything pending before the page goes.
      flush();
    };
  }, [controller]);

  useEffect(
    () => () => {
      if (slugTimer.current) window.clearTimeout(slugTimer.current);
    },
    [],
  );

  const togglePreview = useCallback(() => {
    setMode((current) => (current === 'edit' ? (isWide() ? 'split' : 'preview') : 'edit'));
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        saveNow();
      } else if (key === 'p' && event.shiftKey) {
        event.preventDefault();
        togglePreview();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveNow, togglePreview]);

  useEffect(() => {
    if (!panel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"]')) setPanel(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [panel]);

  /* ---- uploads ---- */

  const uploadImage = useCallback(
    async (file: File): Promise<UploadOutcome> => {
      const form = new FormData();
      form.set('file', file);
      form.set('articleId', initial.id);
      const result = await api<{ asset: AssetDTO; created: boolean }>('/api/assets', { method: 'POST', body: form });
      if (result.ok) return { markdown: result.data.asset.markdown };
      return { error: result.network ? 'Could not upload while offline.' : (result.fields.file ?? result.error) };
    },
    [initial.id],
  );

  async function uploadCover(file: File) {
    const outcome = await uploadImage(file);
    if (!outcome.markdown) {
      notify(outcome.error ?? 'The image could not be uploaded.');
      return;
    }
    const id = /asset:([0-9a-f-]{36})/.exec(outcome.markdown)?.[1];
    if (id) edit({ coverAssetId: id });
  }

  /* ---- history ---- */

  async function restore(versionNo: number): Promise<{ ok: true } | { ok: false; error: string }> {
    await controller.flush();
    const current = controller.getStatus();
    if (current.state === 'conflict') return { ok: false, error: 'Resolve the conflict first.' };
    const result = await api<ArticleDTO>(`/api/articles/${initial.id}/versions/${versionNo}/restore`, {
      method: 'POST',
      json: { expectedRevision: current.revision },
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.status === 409 ? 'The article changed while you were deciding. Close this and try again.' : result.network ? 'You are offline.' : result.error,
      };
    }
    const copy = toDraft(result.data);
    controller.adopt({ draft: copy, revision: result.data.revision });
    showCopy(copy);
    notify(`Version ${versionNo} is back as the current text. The version it replaced is still in the history.`);
    return { ok: true };
  }

  async function deleteArticle() {
    controller.dispose();
    const result = await api(`/api/articles/${initial.id}`, { method: 'DELETE' });
    if (result.ok) router.push('/articles');
    else notify(result.network ? 'Could not delete while offline.' : result.error);
  }

  const words = useMemo(() => countWords(draft.bodyMarkdown), [draft.bodyMarkdown]);
  const minutes = readingMinutes(words);
  const conflict = state.state === 'conflict' ? state.conflict : null;

  const editorCls = mode === 'preview' ? 'hidden' : '';
  const previewCls = mode === 'edit' ? 'hidden' : mode === 'split' ? 'hidden lg:block' : '';

  return (
    <div className="flex h-[calc(100dvh-5.25rem)] min-h-[34rem] flex-col overflow-hidden rounded-xl border bg-card shadow-soft">
      <header className="shrink-0 border-b bg-background">
        <div className="flex items-center gap-2 px-2 py-2 sm:px-3">
          <Link
            href="/articles"
            className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Back to all articles"
            title="All articles"
          >
            <ArrowLeft aria-hidden className="size-4" />
          </Link>
          <input
            value={draft.title}
            onChange={(e) => onTitle(e.target.value)}
            maxLength={200}
            placeholder="Untitled article"
            aria-label="Article title"
            className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 font-serif text-lg font-semibold outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring sm:text-xl"
          />
          <span className="hidden rounded-full border px-2 py-0.5 text-xs text-muted-foreground sm:inline">{STATUS_LABELS[draft.status]}</span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant={panel === 'details' ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={panel === 'details'}
              onClick={() => setPanel(panel === 'details' ? null : 'details')}
              aria-label="Details"
              title="Details: status, slug, tags, cover"
            >
              <SlidersHorizontal aria-hidden />
              <span className="hidden md:inline">Details</span>
            </Button>
            <Button
              type="button"
              variant={panel === 'history' ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={panel === 'history'}
              onClick={() => setPanel(panel === 'history' ? null : 'history')}
              aria-label="Version history"
              title="Version history"
            >
              <History aria-hidden />
              <span className="hidden md:inline">History</span>
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-2 py-1.5 sm:px-3">
          <div role="group" aria-label="View" className="inline-flex shrink-0 overflow-hidden rounded-md border">
            <button type="button" className={modeButton(mode === 'edit')} aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>
              <PenLine aria-hidden className="size-3.5" />
              Edit
            </button>
            <button type="button" className={cn(modeButton(mode === 'split'), 'hidden border-x lg:inline-flex')} aria-pressed={mode === 'split'} onClick={() => setMode('split')}>
              <Columns2 aria-hidden className="size-3.5" />
              Split
            </button>
            <button type="button" className={cn(modeButton(mode === 'preview'), 'border-l')} aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
              <Eye aria-hidden className="size-3.5" />
              Preview
            </button>
          </div>
          <div className="order-last min-w-0 basis-full sm:order-none sm:flex-1 sm:basis-40">
            <SaveIndicator status={state} onRetry={() => void controller.retryNow()} />
          </div>
          <Button type="button" size="sm" variant="outline" onClick={saveNow} title="Save now (Ctrl+S)">
            <Save aria-hidden />
            Save
          </Button>
          <Link
            href={`/articles/${initial.id}/read`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Open the reading view"
          >
            <BookOpen aria-hidden className="size-4" />
            <span className="hidden sm:inline">Read</span>
          </Link>
        </div>
      </header>

      {toast ? (
        <div role="status" className="flex shrink-0 items-start gap-2 border-b bg-accent px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">{toast}</span>
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss" className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground">
            <X aria-hidden className="size-4" />
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className={cn('grid min-h-0 min-w-0 flex-1', mode === 'split' ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1')}>
          <div className={cn('min-h-0 min-w-0', editorCls, mode === 'split' && 'lg:border-r')}>
            <MarkdownEditor
              ref={editor}
              initialValue={initial.bodyMarkdown}
              onChange={(bodyMarkdown) => edit({ bodyMarkdown })}
              onSave={saveNow}
              onTogglePreview={togglePreview}
              onUploadImage={uploadImage}
              onNotice={notify}
              onScroll={(fraction) => {
                const el = previewScroll.current;
                if (el && mode === 'split') el.scrollTop = fraction * (el.scrollHeight - el.clientHeight);
              }}
            />
          </div>
          <div className={cn('min-h-0 min-w-0 bg-background', previewCls)}>
            <PreviewPane ref={previewScroll} markdown={draft.bodyMarkdown} />
          </div>
        </div>

        {panel ? <div className="fixed inset-0 z-30 bg-black/40 2xl:hidden" onClick={() => setPanel(null)} aria-hidden /> : null}
        <aside
          aria-label={panel === 'history' ? 'Version history' : 'Article details'}
          className={cn(
            'z-40 flex w-[min(26rem,100vw)] shrink-0 flex-col border-l bg-card shadow-lg',
            panel ? 'fixed inset-y-0 right-0 2xl:static 2xl:z-auto 2xl:w-96 2xl:shadow-none' : 'hidden',
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
            <div role="tablist" aria-label="Side panel" className="inline-flex overflow-hidden rounded-md border">
              <button type="button" role="tab" aria-selected={panel === 'details'} className={modeButton(panel === 'details')} onClick={() => setPanel('details')}>
                Details
              </button>
              <button type="button" role="tab" aria-selected={panel === 'history'} className={cn(modeButton(panel === 'history'), 'border-l')} onClick={() => setPanel('history')}>
                History
              </button>
            </div>
            <Button type="button" size="icon-sm" variant="ghost" onClick={() => setPanel(null)} aria-label="Close panel">
              <X aria-hidden />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
            {panel === 'details' ? (
              <MetadataPanel
                article={initial}
                draft={draft}
                fieldErrors={state.fieldErrors}
                slug={slug}
                onSlugInput={onSlugInput}
                onUseSuggestion={() => slug.suggestion && void resolveSlug(slug.suggestion, { auto: false, adoptSuggestion: false })}
                onRegenerateSlug={() => {
                  slugAuto.current = true;
                  void resolveSlug(slugify(draftRef.current.title), { auto: true, adoptSuggestion: true });
                }}
                onChange={edit}
                onUploadCover={uploadCover}
                onDelete={() => void deleteArticle()}
              />
            ) : null}
            {panel === 'history' ? (
              <HistoryPanel
                articleId={initial.id}
                refreshKey={state.revision}
                current={{ title: draft.title, body: draft.bodyMarkdown }}
                restoreDisabled={state.state === 'conflict'}
                onRestore={restore}
              />
            ) : null}
          </div>
        </aside>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-0.5 border-t bg-background px-3 py-1.5 text-xs text-muted-foreground">
        <span>{words.toLocaleString('en')} words</span>
        <span>{minutes === 0 ? 'Nothing to read yet' : `${minutes} min read`}</span>
        <span className="hidden sm:inline">{draft.bodyMarkdown.length.toLocaleString('en')} characters</span>
        <span className="ml-auto hidden md:inline">Ctrl+S save · Ctrl+B bold · Ctrl+I italic · Ctrl+K link · Ctrl+Shift+P preview</span>
      </footer>

      <ConflictDialog
        open={Boolean(conflict)}
        mine={draft}
        theirs={conflict?.draft ?? null}
        onKeepMine={() => void controller.keepMine()}
        onTakeTheirs={() => {
          const copy = controller.takeTheirs();
          if (copy) showCopy(copy.draft);
        }}
      />
    </div>
  );
}

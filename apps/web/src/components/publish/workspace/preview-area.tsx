'use client';

import { Columns2, Columns3, GitCompare, Pencil, Square, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PlatformPreview } from '@/components/publishing/previews/platform-preview';
import { EmptyState } from '@/components/brand/branch-art';
import { PreviewScaleContext } from '@/components/publishing/previews/preview-context';
import { PreviewComparison } from '@/components/publishing/previews/preview-comparison';
import { useViewPrefs } from '@/components/shell/view-prefs';
import { buttonVariants } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { StatusChip } from '@/components/ui/status-chip';
import { draftChip } from '@/lib/chips';
import { effectiveLayout, gridClass, SIZE_SCALE } from '@/lib/preview-layout';
import type { DestinationDTO, PlatformId } from '@/lib/publishing';
import type { PreviewLayout, PreviewSize } from '@/lib/view-prefs';
import { cn } from '@/lib/utils';
import { ChecksRow, NoticeBar } from '../shared';
import type { PublishApi } from '../use-publish';
import type { ExpandEntry } from './preview-expand';

const IDLE_MS = 600;

/**
 * A few fields to fix a preview without leaving it: title, description and tags (or the post text for a short post).
 * Each change is saved on its own after a pause, which makes a new version of that destination only. The full editor
 * is one click away for everything else.
 */
export function QuickEdit({ destination, api }: { destination: DestinationDTO; api: PublishApi }) {
  const draft = destination.draft!;
  const info = destination.info;
  const short = info.kind === 'short_form';
  const [title, setTitle] = useState(draft.payload.title);
  const [description, setDescription] = useState(draft.payload.description);
  const [tags, setTags] = useState(draft.payload.tags.join(', '));
  const [body, setBody] = useState(draft.payload.bodyMarkdown);
  const dirty = useRef<Record<string, unknown>>({});
  const timer = useRef<number | null>(null);
  const busy = useRef(false);
  const hash = useRef(draft.payloadSha256);
  const own = useRef(draft.payloadSha256);
  hash.current = draft.payloadSha256;

  // A change that did not come from here (a reset, an accepted suggestion) replaces what is typed.
  useEffect(() => {
    if (draft.payloadSha256 === own.current || busy.current || Object.keys(dirty.current).length > 0) return;
    own.current = draft.payloadSha256;
    setTitle(draft.payload.title);
    setDescription(draft.payload.description);
    setTags(draft.payload.tags.join(', '));
    setBody(draft.payload.bodyMarkdown);
  }, [draft]);

  async function flush() {
    if (busy.current || Object.keys(dirty.current).length === 0) return;
    const patch = dirty.current;
    dirty.current = {};
    busy.current = true;
    const result = await api.edit(destination.platform, draft.id, hash.current, patch);
    busy.current = false;
    if (result.ok) {
      own.current = result.data.draft.payloadSha256;
      hash.current = result.data.draft.payloadSha256;
      if (Object.keys(dirty.current).length > 0) void flush();
    } else dirty.current = { ...patch, ...dirty.current };
  }

  function change(key: 'title' | 'description' | 'tags' | 'bodyMarkdown', value: string) {
    dirty.current = { ...dirty.current, [key]: key === 'tags' ? value.split(/[,\n]/).map((t) => t.trim()).filter(Boolean) : value };
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), IDLE_MS);
  }
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
      void flush();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const locked = !['draft', 'staged', 'pending_approval', 'failed'].includes(draft.status);
  const id = `qe-${destination.platform}`;
  return (
    <fieldset disabled={locked} className="grid gap-3">
      <legend className="sr-only">Quick edit for {info.name}</legend>
      {locked ? <p className="rounded-lg bg-muted px-3 py-2 text-sm">This post is already out or in flight, so it cannot be edited here.</p> : null}
      {short ? (
        <Field label="The post" htmlFor={`${id}-body`}>
          <Textarea
            id={`${id}-body`}
            value={body}
            rows={5}
            onChange={(e) => {
              setBody(e.target.value);
              change('bodyMarkdown', e.target.value);
            }}
            onBlur={() => void flush()}
          />
        </Field>
      ) : (
        <>
          <Field label="Title" htmlFor={`${id}-title`} hint={info.limits.title ? `${[...title].length} of ${info.limits.title} characters.` : undefined}>
            <Input
              id={`${id}-title`}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                change('title', e.target.value);
              }}
              onBlur={() => void flush()}
            />
          </Field>
          {info.kind !== 'link_submission' ? (
            <Field label="Description" htmlFor={`${id}-description`}>
              <Input
                id={`${id}-description`}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  change('description', e.target.value);
                }}
                onBlur={() => void flush()}
              />
            </Field>
          ) : null}
          {info.limits.tagsMax !== 0 ? (
            <Field label="Tags" htmlFor={`${id}-tags`} hint={info.limits.tagsMax ? `Separate with commas. At most ${info.limits.tagsMax}.` : 'Separate with commas.'}>
              <Input
                id={`${id}-tags`}
                value={tags}
                onChange={(e) => {
                  setTags(e.target.value);
                  change('tags', e.target.value);
                }}
                onBlur={() => void flush()}
              />
            </Field>
          ) : null}
        </>
      )}
      <p className="text-xs text-muted-foreground">Changes save as you type and make a new version of this destination only. Any approval you were asked for is void.</p>
    </fieldset>
  );
}

/** What one platform's preview shows: its heading, notices, the checks as pills and the preview itself. The single view adds the quick edit. */
export function PreviewCard({ destination, api, articleId, detailed }: { destination: DestinationDTO; api: PublishApi; articleId: string; detailed: boolean }) {
  const draft = destination.draft;
  const errors = draft?.lint.filter((i) => i.severity === 'error').length ?? 0;
  return (
    <div className="grid min-w-0 content-start gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">{destination.info.name}</h3>
        <StatusChip chip={draftChip(destination.platform, draft)} />
        {detailed ? (
          <span className="text-sm text-muted-foreground">{destination.info.state === 'adapter' ? 'Brand OS can publish this after your approval.' : 'You post this one by hand.'}</span>
        ) : null}
      </div>
      <NoticeBar notice={api.notices[destination.platform]} />
      {draft ? (
        <>
          <ChecksRow issues={draft.lint} empty="No problems found for this platform." />
          <PlatformPreview input={{ platform: destination.platform, payload: draft.payload, extras: draft.extras, account: draft.account }} />
          {detailed ? (
            <details className="rounded-xl border bg-surface" open={errors > 0}>
              <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-4 text-sm font-medium">
                <Pencil aria-hidden className="size-4" />
                Edit title, description and tags
              </summary>
              <div className="border-t p-4">
                <QuickEdit destination={destination} api={api} />
                <Link href={`/articles/${articleId}/publish?view=composer&d=${destination.platform}`} className={buttonVariants({ variant: 'ghost', size: 'sm', className: 'mt-2' })}>
                  Open the full editor
                </Link>
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <p className="rounded-xl border bg-surface p-6 text-sm text-muted-foreground">Preparing the preview…</p>
      )}
    </div>
  );
}

const LAYOUT_OPTIONS: { value: PreviewLayout; icon: LucideIcon; name: string; title: string }[] = [
  { value: 'single', icon: Square, name: 'One large', title: 'One large preview, with a tab for each platform' },
  { value: 'grid2', icon: Columns2, name: '2 columns', title: 'A grid of 2 columns' },
  { value: 'grid3', icon: Columns3, name: '3 columns', title: 'A grid of 3 columns' },
  { value: 'compare', icon: GitCompare, name: 'Compare', title: 'Compare two platforms side by side' },
];

const SIZE_OPTIONS: { value: PreviewSize; label: string; title: string }[] = [
  { value: 'compact', label: 'Compact', title: 'Smaller previews, more on screen' },
  { value: 'comfortable', label: 'Comfortable', title: 'The usual size' },
  { value: 'large', label: 'Large', title: 'Bigger previews, easier to read' },
];

/** Inside the floating window the surface is drawn smaller, because the window has a fixed width. Expand shows it large. */
export const WINDOW_SCALE = 0.65;

/** What the expanded overlay and the footer chips need to know about each preview that is ready. */
export function previewEntries(chosen: DestinationDTO[]): ExpandEntry[] {
  return chosen
    .filter((d) => d.draft)
    .map((d) => ({ platform: d.platform, name: d.info.name, lint: d.draft!.lint, input: { platform: d.platform, payload: d.draft!.payload, extras: d.draft!.extras, account: d.draft!.account } }));
}

/** One tab per chosen platform, in one bordered group. The tab for a platform with something to fix carries the count. */
export function PreviewTabs({ chosen, current, onActive }: { chosen: DestinationDTO[]; current: PlatformId | null; onActive(platform: PlatformId): void }) {
  return (
    <div role="tablist" aria-label="Previews" className="flex min-w-0 max-w-full gap-1 overflow-x-auto rounded-xl border-[1.5px] border-border-strong bg-surface p-1">
      {chosen.map((d) => {
        const n = d.draft?.lint.filter((i) => i.severity === 'error').length ?? 0;
        const selected = current === d.platform;
        return (
          <button
            key={d.platform}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onActive(d.platform)}
            className={cn(
              'inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors duration-[120ms]',
              selected ? 'bg-solid font-semibold text-solid-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {d.info.name}
            {n > 0 ? <span className="rounded-full bg-danger px-1.5 text-xs font-semibold text-danger-foreground">{n}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The previews: one per chosen platform, live. Show them one large with a tab per platform, in a grid of two or three
 * columns, or two side by side to compare. A size control scales every preview, and each preview can be expanded to
 * the whole screen. The layout and size are remembered in this browser. `windowed` is the compact form inside the
 * floating window: one preview at a time, drawn smaller, with no layout controls.
 */
export function PreviewArea({
  api,
  articleId,
  chosen,
  active,
  onActive,
  windowed = false,
}: {
  api: PublishApi;
  articleId: string;
  chosen: DestinationDTO[];
  active: PlatformId | null;
  onActive(platform: PlatformId): void;
  windowed?: boolean;
}) {
  const { prefs, update } = useViewPrefs();
  const current = chosen.find((d) => d.platform === active) ?? chosen[0] ?? null;
  const entries = useMemo(() => previewEntries(chosen), [chosen]);
  const layout = windowed ? 'single' : effectiveLayout(prefs.previewLayout, entries.length);

  if (chosen.length === 0) {
    return (
      <EmptyState title="Choose a platform to see its preview" branches={3}>
        Each platform you tick gets a live, approximate preview of this article. Nothing is sent.
      </EmptyState>
    );
  }

  return (
    <PreviewScaleContext.Provider value={windowed ? WINDOW_SCALE : SIZE_SCALE[prefs.previewSize]}>
      <div className="@container grid gap-4">
        {windowed ? null : (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <span className="mono-label text-muted-foreground">Layout</span>
              <Segmented
                label="Preview layout"
                value={layout}
                onChange={(value) => update({ previewLayout: value })}
                options={LAYOUT_OPTIONS.map((o) => ({
                  value: o.value,
                  title: o.value === 'compare' && entries.length < 2 ? 'Prepare at least two previews to compare them' : o.title,
                  disabled: o.value === 'compare' && entries.length < 2,
                  label: (
                    <>
                      <o.icon aria-hidden className="size-4" />
                      <span className="sr-only @lg:not-sr-only">{o.name}</span>
                    </>
                  ),
                }))}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="mono-label text-muted-foreground">Size</span>
              <Segmented label="Preview size" value={prefs.previewSize} onChange={(value) => update({ previewSize: value })} options={SIZE_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))} />
            </div>
          </div>
        )}

        {layout === 'single' ? <PreviewTabs chosen={chosen} current={current?.platform ?? null} onActive={onActive} /> : null}

        {layout === 'compare' ? (
          <PreviewComparison items={entries.map((e) => e.input)} />
        ) : layout === 'single' ? (
          current ? <PreviewCard key={current.platform} destination={current} api={api} articleId={articleId} detailed /> : null
        ) : (
          <>
            <p className="text-xs text-muted-foreground @2xl:hidden">This area is narrow, so the previews stack. Use Full view to see them side by side.</p>
            <div className={cn('grid grid-cols-1 items-start gap-4', gridClass(layout))}>
              {chosen.map((d) => (
                <PreviewCard key={d.platform} destination={d} api={api} articleId={articleId} detailed={false} />
              ))}
            </div>
          </>
        )}
      </div>
    </PreviewScaleContext.Provider>
  );
}

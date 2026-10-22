'use client';

import { GitCompare, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PlatformPreview } from '@/components/publishing/previews/platform-preview';
import { PreviewComparison } from '@/components/publishing/previews/preview-comparison';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { StatusChip } from '@/components/ui/status-chip';
import { draftChip } from '@/lib/chips';
import type { DestinationDTO, PlatformId } from '@/lib/publishing';
import { cn } from '@/lib/utils';
import { LintList, NoticeBar } from '../shared';
import type { PublishApi } from '../use-publish';

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

/**
 * Area 3: one preview per chosen platform, live. Choose a tab to see that platform's approximate preview of this
 * article, with the device and light or dark toggles of the preview itself; "Compare side by side" shows two.
 */
export function PreviewArea({
  api,
  articleId,
  chosen,
  active,
  onActive,
}: {
  api: PublishApi;
  articleId: string;
  chosen: DestinationDTO[];
  active: PlatformId | null;
  onActive(platform: PlatformId): void;
}) {
  const [compare, setCompare] = useState(false);
  const current = chosen.find((d) => d.platform === active) ?? chosen[0] ?? null;
  const prepared = useMemo(() => chosen.filter((d) => d.draft), [chosen]);

  if (chosen.length === 0) {
    return (
      <div className="rounded-xl border bg-surface p-8 text-center">
        <h3 className="text-lg font-semibold">Choose a platform to see its preview</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">Each platform you tick gets a live, approximate preview of this article. Nothing is sent.</p>
      </div>
    );
  }

  const errors = current?.draft?.lint.filter((i) => i.severity === 'error').length ?? 0;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Previews" className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 pb-0.5">
          {chosen.map((d) => {
            const n = d.draft?.lint.filter((i) => i.severity === 'error').length ?? 0;
            return (
              <button
                key={d.platform}
                type="button"
                role="tab"
                aria-selected={!compare && current?.platform === d.platform}
                onClick={() => {
                  setCompare(false);
                  onActive(d.platform);
                }}
                className={cn(
                  'inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors duration-[120ms]',
                  !compare && current?.platform === d.platform ? 'border-primary bg-accent text-accent-foreground' : 'border-border bg-surface text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {d.info.name}
                {n > 0 ? <span className="rounded-full bg-danger px-1.5 text-xs font-semibold text-danger-foreground">{n}</span> : null}
              </button>
            );
          })}
        </div>
        {prepared.length > 1 ? (
          <Button type="button" size="sm" variant={compare ? 'default' : 'outline'} aria-pressed={compare} onClick={() => setCompare((c) => !c)}>
            <GitCompare aria-hidden />
            Compare side by side
          </Button>
        ) : null}
      </div>

      {compare ? (
        <PreviewComparison items={prepared.map((d) => ({ platform: d.platform, payload: d.draft!.payload, extras: d.draft!.extras, account: d.draft!.account }))} />
      ) : current ? (
        <div className="grid gap-3" key={current.platform}>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{current.info.name}</h3>
            <StatusChip chip={draftChip(current.platform, current.draft)} />
            <span className="text-sm text-muted-foreground">{current.info.state === 'adapter' ? 'Brand OS can publish this after your approval.' : 'You post this one by hand.'}</span>
          </div>
          <NoticeBar notice={api.notices[current.platform]} />
          {current.draft ? (
            <>
              <LintList issues={current.draft.lint} empty="No problems found for this platform." />
              <PlatformPreview input={{ platform: current.platform, payload: current.draft.payload, extras: current.draft.extras, account: current.draft.account }} />
              <details className="rounded-lg border bg-surface" open={errors > 0}>
                <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm font-medium">
                  <Pencil aria-hidden className="size-4" />
                  Edit title, description and tags
                </summary>
                <div className="border-t p-3">
                  <QuickEdit destination={current} api={api} />
                  <Link href={`/articles/${articleId}/publish?view=composer&d=${current.platform}`} className={buttonVariants({ variant: 'ghost', size: 'sm', className: 'mt-2' })}>
                    Open the full editor
                  </Link>
                </div>
              </details>
            </>
          ) : (
            <p className="rounded-xl border bg-surface p-6 text-sm text-muted-foreground">Preparing the preview…</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

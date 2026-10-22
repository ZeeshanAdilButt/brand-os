'use client';

import { RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DiffView } from '@/components/articles/diff-view';
import { WordDiff } from '@/components/ai/result-view';
import { Counters } from '@/components/publishing/previews/skins';
import { PlatformPreview } from '@/components/publishing/previews/platform-preview';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { StatusChip } from '@/components/ui/status-chip';
import { PLATFORMS } from '@/lib/catalog';
import { draftChip } from '@/lib/chips';
import { PAYLOAD_FIELD_LABELS, type DestinationDTO, type PayloadField } from '@/lib/publishing';
import { splitPosts } from '@/lib/short-form';
import { cn } from '@/lib/utils';
import { AiAssist, type AiState } from './ai-assist';
import { LintList, NoticeBar, type LintFix } from './shared';
import type { EditPatch, PublishApi } from './use-publish';

interface Values {
  title: string;
  description: string;
  tags: string;
  coverImageUrl: string;
  canonicalUrl: string;
  series: string;
  bodyMarkdown: string;
  subreddit: string;
  instance: string;
  path: string;
}

function valuesOf(draft: NonNullable<DestinationDTO['draft']>): Values {
  return {
    title: draft.payload.title,
    description: draft.payload.description,
    tags: draft.payload.tags.join(', '),
    coverImageUrl: draft.payload.coverImageUrl ?? '',
    canonicalUrl: draft.payload.canonicalUrl ?? '',
    series: draft.payload.series ?? '',
    bodyMarkdown: draft.payload.bodyMarkdown,
    subreddit: draft.extras.options?.subreddit ?? '',
    instance: draft.extras.options?.instance ?? '',
    path: draft.extras.site?.path ?? '',
  };
}

const parseTags = (text: string) => text.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);

function toPatch(changed: Partial<Values>): EditPatch {
  const patch: EditPatch = {};
  if (changed.title !== undefined) patch.title = changed.title;
  if (changed.description !== undefined) patch.description = changed.description;
  if (changed.tags !== undefined) patch.tags = parseTags(changed.tags);
  if (changed.coverImageUrl !== undefined) patch.coverImageUrl = changed.coverImageUrl.trim() || null;
  if (changed.canonicalUrl !== undefined) patch.canonicalUrl = changed.canonicalUrl.trim() || null;
  if (changed.series !== undefined) patch.series = changed.series.trim() || null;
  if (changed.bodyMarkdown !== undefined) patch.bodyMarkdown = changed.bodyMarkdown;
  if (changed.subreddit !== undefined || changed.instance !== undefined) {
    patch.options = {
      ...(changed.subreddit !== undefined ? { subreddit: changed.subreddit } : {}),
      ...(changed.instance !== undefined ? { instance: changed.instance } : {}),
    };
  }
  if (changed.path !== undefined) patch.site = { path: changed.path };
  return patch;
}

const IDLE_MS = 700;

/**
 * Edit one destination. Every change is saved on its own after a short pause (there is no save button to forget),
 * and every change makes a new version of the post: any approval you were asked for is void, and the post has to be
 * staged and approved again. The preview always shows what was saved, in that platform’s typography.
 */
export function DestinationEditor({ destination, api, article, ai, onApplied, heading = true }: { destination: DestinationDTO; api: PublishApi; article: { title: string; body: string }; ai: AiState; onApplied(): void; heading?: boolean }) {
  const draft = destination.draft!;
  const info = PLATFORMS[destination.platform];
  const [values, setValues] = useState<Values>(() => valuesOf(draft));
  const [saveState, setSaveState] = useState<'saved' | 'unsaved' | 'saving'>('saved');
  const [pane, setPane] = useState<'edit' | 'preview'>('edit');
  const dirty = useRef<Partial<Values>>({});
  const timer = useRef<number | null>(null);
  const saving = useRef(false);
  const hash = useRef(draft.payloadSha256);
  const own = useRef(draft.payloadSha256);
  hash.current = draft.payloadSha256;

  // A change that did not come from this editor (a reset, an accepted suggestion) replaces what is typed.
  useEffect(() => {
    if (draft.payloadSha256 === own.current || saving.current || Object.keys(dirty.current).length > 0) return;
    own.current = draft.payloadSha256;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValues(valuesOf(draft));
  }, [draft]);

  async function flush() {
    if (saving.current) return;
    const changed = dirty.current;
    if (Object.keys(changed).length === 0) return;
    dirty.current = {};
    saving.current = true;
    setSaveState('saving');
    const result = await api.edit(destination.platform, draft.id, hash.current, toPatch(changed));
    saving.current = false;
    if (result.ok) {
      own.current = result.data.draft.payloadSha256;
      hash.current = result.data.draft.payloadSha256;
    } else {
      // Put the unsaved text back so nothing typed is lost; the message says what went wrong.
      dirty.current = { ...changed, ...dirty.current };
    }
    if (Object.keys(dirty.current).length > 0 && result.ok) void flush();
    else setSaveState(result.ok ? 'saved' : 'unsaved');
  }

  function change<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    dirty.current = { ...dirty.current, [key]: value };
    setSaveState('unsaved');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), IDLE_MS);
  }
  // Closing the editor never loses typing: whatever is waiting is saved on the way out.
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
      void flush();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const focus = (id: string) => () => {
    setPane('edit');
    window.setTimeout(() => document.getElementById(id)?.focus(), 0);
  };
  const tagsMax = info.limits.tagsMax;
  const fixes: Partial<Record<string, LintFix>> = {
    title_empty: { label: 'Go to the title', run: focus('f-title') },
    title_long: { label: 'Go to the title', run: focus('f-title') },
    body_empty: { label: 'Go to the text', run: focus('f-body') },
    image_local: { label: 'Go to the text', run: focus('f-body') },
    link_not_public: { label: 'Go to the text', run: focus('f-body') },
    canonical_missing: { label: 'Go to the field', run: focus('f-canonical') },
    url_missing: { label: 'Go to the field', run: focus('f-canonical') },
    subreddit_missing: { label: 'Choose it', run: focus('f-subreddit') },
    instance_missing: { label: 'Set it', run: focus('f-instance') },
    cover_not_public: { label: 'Remove the cover', run: () => change('coverImageUrl', '') },
    ...(tagsMax ? { tags_too_many: { label: `Keep the first ${tagsMax}`, run: () => change('tags', parseTags(values.tags).slice(0, tagsMax).join(', ')) } } : {}),
    ...(info.limits.thread ? { post_too_long: { label: 'Split into a thread', run: () => change('bodyMarkdown', splitPosts(destination.platform, values.bodyMarkdown).map((p) => p.text).join('\n---\n')) } } : {}),
    repo_missing: { label: 'Open site settings', run: () => window.location.assign('/platforms/integrations#site') },
  };

  const edited = draft.divergence.edited;
  const chip = draftChip(destination.platform, draft);
  const site = draft.extras.site;
  const seen = draft.remoteInfo;
  const titleLength = [...values.title].length;
  const preview = useMemo(() => ({ platform: destination.platform, payload: draft.payload, extras: draft.extras, account: draft.account }), [destination.platform, draft.payload, draft.extras, draft.account]);
  const locked = !['draft', 'staged', 'pending_approval', 'failed'].includes(draft.status);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {heading ? (
          <>
            <h3 className="text-lg font-semibold">{info.name}</h3>
            <StatusChip chip={chip} />
          </>
        ) : null}
        {edited.length > 0 ? (
          <span className="inline-flex min-h-6 items-center rounded-full border border-info/25 bg-info-subtle px-2 text-xs font-semibold text-info" title="Fields you changed after the text was generated">
            Edited: {edited.map((f) => PAYLOAD_FIELD_LABELS[f]).join(', ')}
          </span>
        ) : null}
        <span aria-live="polite" className={cn('ml-auto text-xs', saveState === 'unsaved' ? 'text-warning' : 'text-muted-foreground')}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'unsaved' ? 'Unsaved changes' : 'All changes saved'}
        </span>
        <div className="xl:hidden">
          <Segmented<'edit' | 'preview'>
            label="Show"
            value={pane}
            onChange={setPane}
            options={[
              { value: 'edit', label: 'Edit' },
              { value: 'preview', label: 'Preview' },
            ]}
          />
        </div>
      </div>
      <NoticeBar notice={api.notices[destination.platform]} />
      {locked ? <p className="rounded-lg bg-muted px-3 py-2 text-sm">This post is {draft.status === 'published' ? 'already out' : 'in flight or has an unknown result'}, so it cannot be edited here.</p> : null}
      {draft.divergence.fromSource.length > 0 && draft.status !== 'source_changed' ? (
        <p className="rounded-lg border border-info/25 bg-info-subtle px-3 py-2 text-sm text-info">
          Differs from your article in: {draft.divergence.fromSource.map((f) => PAYLOAD_FIELD_LABELS[f]).join(', ')}. That is expected for this destination (for example cleaned tags or a footer).
        </p>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className={cn('grid min-w-0 content-start gap-4', pane === 'preview' && 'hidden xl:grid')}>
          <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
            Editing makes a new version of this post, so any approval you were asked for is void and you approve again. Changes are saved as you type.
          </p>
          <fieldset disabled={locked} className="grid min-w-0 gap-4">
            {info.limits.title !== null || info.kind !== 'short_form' ? (
              <Field label="Title" htmlFor="f-title" hint={info.limits.title ? `${titleLength} of ${info.limits.title} characters.` : undefined}>
                <Input id="f-title" value={values.title} onChange={(e) => change('title', e.target.value)} onBlur={() => void flush()} />
              </Field>
            ) : null}
            {info.kind !== 'short_form' && info.kind !== 'link_submission' ? (
              <Field label={destination.platform === 'substack' ? 'Subtitle' : 'Description'} htmlFor="f-description">
                <Input id="f-description" value={values.description} onChange={(e) => change('description', e.target.value)} onBlur={() => void flush()} />
              </Field>
            ) : null}

            <Field
              label={info.kind === 'short_form' ? 'The post' : info.kind === 'video' ? 'Description' : info.kind === 'link_submission' ? 'Text (optional)' : 'Text (Markdown)'}
              htmlFor="f-body"
              hint={info.kind === 'short_form' && info.limits.thread ? 'A line that holds only --- starts a new post in a thread.' : info.capabilities.restrictions[0]}
            >
              <Textarea id="f-body" value={values.bodyMarkdown} onChange={(e) => change('bodyMarkdown', e.target.value)} onBlur={() => void flush()} rows={info.kind === 'short_form' ? 8 : 14} spellCheck className="font-mono text-[0.8125rem] leading-6" />
            </Field>
            {info.kind === 'short_form' ? <div className="text-xs text-muted-foreground"><Counters platform={destination.platform} payload={{ ...draft.payload, bodyMarkdown: values.bodyMarkdown }} /></div> : null}

            <div className="grid gap-4 sm:grid-cols-2">
              {info.limits.tagsMax !== 0 && destination.platform !== 'hackernews' && destination.platform !== 'reddit' && destination.platform !== 'substack' ? (
                <Field label="Tags" htmlFor="f-tags" hint={tagsMax ? `Separate with commas. At most ${tagsMax}.` : 'Separate with commas.'}>
                  <Input id="f-tags" value={values.tags} onChange={(e) => change('tags', e.target.value)} onBlur={() => void flush()} />
                </Field>
              ) : null}
              <Field label="Canonical URL" htmlFor="f-canonical" hint="The page on your own site this points back to.">
                <Input id="f-canonical" value={values.canonicalUrl} onChange={(e) => change('canonicalUrl', e.target.value)} onBlur={() => void flush()} inputMode="url" placeholder="https://example-blog.dev/posts/…" />
              </Field>
              {info.kind === 'long_form' || info.kind === 'video' ? (
                <Field label={info.kind === 'video' ? 'Thumbnail address' : 'Cover image address'} htmlFor="f-cover" hint="A public https address. Images stored in this app cannot be sent.">
                  <Input id="f-cover" value={values.coverImageUrl} onChange={(e) => change('coverImageUrl', e.target.value)} onBlur={() => void flush()} inputMode="url" />
                </Field>
              ) : null}
              {info.capabilities.series ? (
                <Field label="Series" htmlFor="f-series">
                  <Input id="f-series" value={values.series} onChange={(e) => change('series', e.target.value)} onBlur={() => void flush()} maxLength={100} />
                </Field>
              ) : null}
              {destination.platform === 'reddit' ? (
                <Field label="Subreddit" htmlFor="f-subreddit" hint="Read its rules about self-promotion first.">
                  <Input id="f-subreddit" value={values.subreddit} onChange={(e) => change('subreddit', e.target.value)} onBlur={() => void flush()} placeholder="programming" />
                </Field>
              ) : null}
              {destination.platform === 'mastodon' ? (
                <Field label="Your instance" htmlFor="f-instance" hint="For the share link. The limit is set by your instance.">
                  <Input id="f-instance" value={values.instance} onChange={(e) => change('instance', e.target.value)} onBlur={() => void flush()} placeholder="hachyderm.io" />
                </Field>
              ) : null}
              {site ? (
                <Field label="File path in the repository" htmlFor="f-path" hint="Changing it starts the file check over.">
                  <Input id="f-path" value={values.path} onChange={(e) => change('path', e.target.value)} onBlur={() => void flush()} className="font-mono" spellCheck={false} />
                </Field>
              ) : null}
            </div>

            {site ? (
              <div className="grid gap-1.5 rounded-lg border bg-surface p-3 text-sm">
                <p className="font-semibold">Where the file goes</p>
                <p className="text-muted-foreground">
                  {site.repo ?? 'No repository set'} on {site.baseBranch}, as <span className="font-mono">{site.path}</span>.
                </p>
                {seen ? (
                  <p className={cn(seen.fileExists ? 'text-warning' : 'text-success')}>
                    {seen.fileExists ? `A file already exists there (blob ${seen.fileSha?.slice(0, 7)}).` : 'The path is free.'}
                  </p>
                ) : (
                  <p className="text-muted-foreground">Not checked yet. Checking only reads the repository.</p>
                )}
                {seen?.fileExists ? (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={site.updateExisting} onChange={(e) => void api.edit(destination.platform, draft.id, hash.current, { site: { updateExisting: e.target.checked } })} />
                    Update the existing file (I looked at it)
                  </label>
                ) : null}
              </div>
            ) : null}

            {draft.tagReport.changes.length > 0 ? (
              <div className="rounded-lg bg-muted px-3 py-2">
                <p className="text-xs font-semibold">What was changed for {info.name}</p>
                <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
                  {draft.tagReport.changes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </fieldset>

          <section aria-label="Checks" className="grid gap-2">
            <h4 className="text-sm font-semibold">Checks</h4>
            <LintList issues={draft.lint} fixes={fixes} />
          </section>

          <details className="rounded-lg border bg-surface">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Differences</summary>
            <div className="grid gap-4 border-t p-3">
              <div className="grid gap-2">
                <p className="text-sm font-semibold">From what was generated</p>
                {edited.length === 0 ? <p className="text-sm text-muted-foreground">You have not changed anything.</p> : <Differences generated={draft.generated} payload={draft.payload} fields={edited} />}
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" disabled={edited.length === 0 || locked || api.anyBusy} onClick={() => void api.reset(destination.platform, draft.id)}>
                    <RotateCcw aria-hidden />
                    Reset to generated
                  </Button>
                  {edited.filter((f) => f !== 'bodyMarkdown').map((f) => (
                    <Button key={f} type="button" size="xs" variant="ghost" disabled={locked || api.anyBusy} onClick={() => void api.reset(destination.platform, draft.id, [f as PayloadField])}>
                      Reset {PAYLOAD_FIELD_LABELS[f].toLowerCase()}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="grid gap-2">
                <p className="text-sm font-semibold">From your article</p>
                <DiffView oldText={article.body} newText={draft.payload.bodyMarkdown} />
              </div>
            </div>
          </details>

          <AiAssist articleId={draft.articleId} draft={draft} ai={ai} onApplied={onApplied} />
        </div>

        <div className={cn('min-w-0', pane === 'edit' && 'hidden xl:block')}>
          <PlatformPreview input={preview} />
        </div>
      </div>
    </div>
  );
}

type DraftDTO = NonNullable<DestinationDTO['draft']>;

function Differences({ generated, payload, fields }: { generated: DraftDTO['generated']; payload: DraftDTO['payload']; fields: PayloadField[] }) {
  return (
    <div className="grid gap-2">
      {fields.map((field) =>
        field === 'bodyMarkdown' ? (
          <DiffView key={field} oldText={generated.bodyMarkdown} newText={payload.bodyMarkdown} />
        ) : (
          <div key={field} className="grid gap-1">
            <p className="text-xs font-semibold">{PAYLOAD_FIELD_LABELS[field]}</p>
            <WordDiff original={Array.isArray(generated[field]) ? (generated[field] as string[]).join(', ') : String(generated[field] ?? '')} proposed={Array.isArray(payload[field]) ? (payload[field] as string[]).join(', ') : String(payload[field] ?? '')} />
          </div>
        ),
      )}
    </div>
  );
}

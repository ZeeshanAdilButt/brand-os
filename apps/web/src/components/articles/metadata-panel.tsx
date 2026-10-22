'use client';

import { ImagePlus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { ARTICLE_STATUSES, LIMITS, SOURCE_KIND_LABELS, STATUS_HINTS, STATUS_LABELS, type ArticleDTO, type AssetDTO } from '@/lib/articles';
import { api } from '@/lib/api-client';
import type { Draft } from '@/lib/autosave';
import { cn } from '@/lib/utils';

export type SlugState = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

export interface SlugView {
  value: string;
  state: SlugState;
  message: string | null;
  suggestion: string | null;
  auto: boolean;
}

interface Props {
  article: Pick<ArticleDTO, 'id' | 'sourceKind' | 'sourceRef' | 'extraMetadata' | 'createdAt'>;
  draft: Draft;
  fieldErrors: Record<string, string>;
  slug: SlugView;
  onSlugInput(value: string): void;
  onUseSuggestion(): void;
  onRegenerateSlug(): void;
  onChange(patch: Partial<Draft>): void;
  onUploadCover(file: File): Promise<void>;
  onDelete(): void;
}

function TagsEditor({ tags, onChange, error }: { tags: string[]; onChange(tags: string[]): void; error?: string | undefined }) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  function commit(raw: string) {
    const parts = raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...tags];
    for (const part of parts) {
      if (part.length > LIMITS.tag) {
        setProblem(`A tag can be at most ${LIMITS.tag} characters.`);
        return;
      }
      if (!next.some((t) => t.toLowerCase() === part.toLowerCase())) next.push(part);
    }
    if (next.length > LIMITS.tags) {
      setProblem(`Use at most ${LIMITS.tags} tags.`);
      return;
    }
    setProblem(null);
    setText('');
    onChange(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit(text);
    } else if (event.key === 'Backspace' && text === '' && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <Field label="Tags" htmlFor="meta-tags" hint="Press Enter or comma to add. Tags are searchable and become destination tags when publishing." error={problem ?? error}>
      <div className="flex flex-wrap gap-1.5 rounded-md border border-input bg-background p-1.5 focus-within:ring-[3px] focus-within:ring-ring/40">
        {tags.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {tag}
            <button
              type="button"
              onClick={() => onChange(tags.filter((t) => t !== tag))}
              aria-label={`Remove tag ${tag}`}
              className="grid size-4 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        ))}
        <input
          id="meta-tags"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(text)}
          placeholder={tags.length === 0 ? 'postgres, performance' : ''}
          className="h-7 min-w-24 flex-1 bg-transparent px-1.5 text-sm outline-none placeholder:text-muted-foreground/80"
        />
      </div>
    </Field>
  );
}

function CoverPicker({ coverAssetId, onChange, onUpload }: { coverAssetId: string | null; onChange(id: string | null): void; onUpload(file: File): Promise<void> }) {
  const [assets, setAssets] = useState<AssetDTO[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void api<{ assets: AssetDTO[] }>('/api/assets').then((result) => {
      if (live) setAssets(result.ok ? result.data.assets.filter((a) => a.mime.startsWith('image/')) : []);
    });
    return () => {
      live = false;
    };
  }, [open]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    await onUpload(file);
    setBusy(false);
    if (input.current) input.current.value = '';
  }

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-sm font-medium">Cover image</legend>
      {coverAssetId ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/assets/${coverAssetId}`} alt="Current cover" className="aspect-[16/9] w-full rounded-md border object-cover" />
      ) : (
        <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">No cover image</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => input.current?.click()} disabled={busy}>
          <ImagePlus aria-hidden />
          {busy ? 'Uploading...' : 'Upload'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          Choose from uploads
        </Button>
        {coverAssetId ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
            Remove
          </Button>
        ) : null}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden tabIndex={-1} onChange={(e) => void pick(e.target.files?.[0])} />
      </div>
      {open ? (
        assets === null ? (
          <p className="text-sm text-muted-foreground">Loading uploads...</p>
        ) : assets.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing uploaded yet. Upload an image, or paste one into the editor.</p>
        ) : (
          <ul className="grid grid-cols-3 gap-2">
            {assets.map((asset) => (
              <li key={asset.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(asset.id);
                    setOpen(false);
                  }}
                  aria-label={`Use ${asset.filename} as the cover`}
                  aria-pressed={asset.id === coverAssetId}
                  className={cn('block w-full overflow-hidden rounded-md border', asset.id === coverAssetId && 'ring-2 ring-ring')}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={asset.url} alt="" loading="lazy" className="aspect-square w-full object-cover" />
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </fieldset>
  );
}

export function MetadataPanel({ article, draft, fieldErrors, slug, onSlugInput, onUseSuggestion, onRegenerateSlug, onChange, onUploadCover, onDelete }: Props) {
  const [canonical, setCanonical] = useState(draft.canonicalUrl ?? '');
  const [canonicalError, setCanonicalError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function commitCanonical(value: string) {
    const text = value.trim();
    if (text === '') {
      setCanonicalError(null);
      onChange({ canonicalUrl: null });
      return;
    }
    try {
      const url = new URL(text);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
      setCanonicalError(null);
      onChange({ canonicalUrl: url.toString() });
    } catch {
      setCanonicalError('Enter a full web address starting with http:// or https://.');
    }
  }

  const slugMessage =
    slug.state === 'checking'
      ? 'Checking...'
      : slug.state === 'available'
        ? 'Available'
        : slug.state === 'taken'
          ? slug.message
          : slug.state === 'invalid'
            ? slug.message
            : null;
  const extra = Object.entries(article.extraMetadata).filter(([, v]) => v !== null && v !== undefined);

  return (
    <div className="grid gap-5">
      <Field label="Status" htmlFor="meta-status" hint={STATUS_HINTS[draft.status]} error={fieldErrors.status}>
        <Select id="meta-status" value={draft.status} onChange={(e) => onChange({ status: e.target.value as Draft['status'] })}>
          {ARTICLE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </Select>
      </Field>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="meta-slug" className="text-sm font-medium">
          Slug
        </label>
        <Input
          id="meta-slug"
          value={slug.value}
          onChange={(e) => onSlugInput(e.target.value)}
          maxLength={LIMITS.slug}
          spellCheck={false}
          autoCapitalize="none"
          aria-invalid={slug.state === 'taken' || slug.state === 'invalid' || fieldErrors.slug ? true : undefined}
          aria-describedby="meta-slug-hint"
          className="font-mono"
        />
        <p
          id="meta-slug-hint"
          aria-live="polite"
          className={cn('text-xs leading-relaxed', slug.state === 'taken' || slug.state === 'invalid' ? 'font-medium text-destructive' : slug.state === 'available' ? 'text-success' : 'text-muted-foreground')}
        >
          {slugMessage ?? 'The last part of the address: lower-case letters, numbers and hyphens. It only has to be unique among your own articles.'}
          {fieldErrors.slug && slug.state !== 'taken' ? ` ${fieldErrors.slug}` : ''}
        </p>
        <div className="flex flex-wrap gap-2">
          {slug.state === 'taken' && slug.suggestion ? (
            <Button type="button" size="xs" variant="outline" onClick={onUseSuggestion}>
              Use {slug.suggestion}
            </Button>
          ) : null}
          {!slug.auto ? (
            <Button type="button" size="xs" variant="ghost" onClick={onRegenerateSlug}>
              Make it from the title
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">Follows the title until you edit it.</span>
          )}
        </div>
      </div>

      <Field label="Description" htmlFor="meta-description" hint={`${draft.description.length} of ${LIMITS.description}. Used as the summary on each destination.`} error={fieldErrors.description}>
        <Textarea id="meta-description" value={draft.description} onChange={(e) => onChange({ description: e.target.value })} maxLength={LIMITS.description} rows={3} />
      </Field>

      <TagsEditor tags={draft.tags} onChange={(tags) => onChange({ tags })} error={fieldErrors.tags} />

      <Field
        label="Canonical URL"
        htmlFor="meta-canonical"
        hint="Where this article lives first. Other destinations point back to it."
        error={canonicalError ?? fieldErrors.canonicalUrl}
      >
        <Input
          id="meta-canonical"
          type="url"
          inputMode="url"
          value={canonical}
          onChange={(e) => setCanonical(e.target.value)}
          onBlur={(e) => commitCanonical(e.target.value)}
          placeholder="https://example-blog.dev/my-article"
          maxLength={LIMITS.canonicalUrl}
          aria-invalid={canonicalError ? true : undefined}
        />
      </Field>

      <CoverPicker coverAssetId={draft.coverAssetId} onChange={(id) => onChange({ coverAssetId: id })} onUpload={onUploadCover} />

      <section aria-labelledby="meta-source" className="rounded-lg border bg-muted/30 p-3 text-sm">
        <h3 id="meta-source" className="label-caps text-muted-foreground">
          Origin
        </h3>
        <p className="mt-1.5 leading-relaxed">
          {SOURCE_KIND_LABELS[article.sourceKind]}
          {article.sourceRef ? (
            <>
              {': '}
              <span className="break-all font-mono text-xs">{article.sourceRef}</span>
            </>
          ) : null}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Created {new Date(article.createdAt).toLocaleDateString('en', { dateStyle: 'medium' })}</p>
        {extra.length > 0 ? (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-medium">
              {extra.length} other {extra.length === 1 ? 'field' : 'fields'} kept from the import
            </summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {extra.slice(0, 20).map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="font-mono text-muted-foreground">{key}</dt>
                  <dd className="break-words">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="meta-danger" className="rounded-lg border border-destructive/30 p-3">
        <h3 id="meta-danger" className="text-sm font-medium">
          Delete this article
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Removes the article and its whole version history. Uploaded images stay in your uploads.</p>
        {confirmingDelete ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="destructive" onClick={onDelete}>
              Delete for good
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => setConfirmingDelete(true)}>
            <Trash2 aria-hidden />
            Delete
          </Button>
        )}
      </section>
    </div>
  );
}

'use client';

import { ChevronsUpDown, Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { ArticleStatusBadge } from '@/components/articles/status-badge';
import { Input } from '@/components/ui/field';
import { formatWhen } from '@/lib/format';
import { filterArticles, type ArticleOption } from '@/lib/publish-workspace';
import { cn } from '@/lib/utils';

const wordsText = (words: number) => (words === 0 ? 'No text yet' : `about ${words.toLocaleString('en')} words`);

/**
 * Area 1: choose the article. The chosen article is always visible; "Change" opens a searchable list, newest first.
 * The list is a radio group, so the arrow keys move through it and Enter or Space chooses.
 */
export function ArticlePicker({ articles, selectedId, onSelect }: { articles: ArticleOption[]; selectedId: string | null; onSelect(id: string): void }) {
  const [open, setOpen] = useState(selectedId === null);
  const [query, setQuery] = useState('');
  const name = useId();
  const selected = articles.find((a) => a.id === selectedId) ?? null;
  const shown = useMemo(() => filterArticles(articles, query), [articles, query]);

  if (articles.length === 0) {
    return (
      <div className="rounded-lg bg-muted px-3 py-3 text-sm">
        <p className="font-medium">You have no articles yet.</p>
        <p className="mt-0.5 text-muted-foreground">Import or write one first, then come back here to choose where it goes.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {selected ? (
        <div className="flex items-start gap-3 rounded-lg border bg-background p-3">
          <div className="min-w-0 flex-1">
            <p className="font-serif text-lg leading-6" data-testid="selected-article">
              {selected.title || 'Untitled article'}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <ArticleStatusBadge status={selected.status} />
              <span>{wordsText(selected.words)}</span>
              <span>Edited {formatWhen(selected.updatedAt)}</span>
            </p>
          </div>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-input bg-surface px-2.5 text-sm font-medium hover:bg-accent"
          >
            <ChevronsUpDown aria-hidden className="size-4" />
            {open ? 'Close' : 'Change'}
          </button>
        </div>
      ) : null}

      {open ? (
        <div className="grid gap-2">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your articles" aria-label="Search your articles" className="pl-9" />
          </div>
          <fieldset className="max-h-64 overflow-y-auto rounded-lg border bg-background">
            <legend className="sr-only">Choose an article</legend>
            {shown.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">No article matches “{query}”.</p>
            ) : (
              <ul className="divide-y">
                {shown.map((a) => {
                  const id = `${name}-${a.id}`;
                  return (
                    <li key={a.id}>
                      <label htmlFor={id} className={cn('flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-accent', a.id === selectedId && 'bg-accent')}>
                        <input
                          id={id}
                          type="radio"
                          name={name}
                          checked={a.id === selectedId}
                          onChange={() => {
                            onSelect(a.id);
                            setOpen(false);
                            setQuery('');
                          }}
                          className="mt-1 size-4 shrink-0 accent-[var(--primary)]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{a.title || 'Untitled article'}</span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            <ArticleStatusBadge status={a.status} />
                            <span>{wordsText(a.words)}</span>
                            <span>{formatWhen(a.updatedAt)}</span>
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}

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
export function ArticlePicker({ articles, selectedId, onSelect, listOnly = false }: { articles: ArticleOption[]; selectedId: string | null; onSelect(id: string): void; /** Only the search and the list (the page header shows the chosen article and opens this in a dialog). */ listOnly?: boolean }) {
  const [open, setOpen] = useState(selectedId === null || listOnly);
  const [query, setQuery] = useState('');
  const name = useId();
  const selected = articles.find((a) => a.id === selectedId) ?? null;
  const shown = useMemo(() => filterArticles(articles, query), [articles, query]);

  if (articles.length === 0) {
    return (
      <div className="rounded-xl bg-muted px-4 py-4 text-sm">
        <p className="font-medium">You have no articles yet.</p>
        <p className="mt-0.5 text-muted-foreground">Import or write one first, then come back here to choose where it goes.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {selected && !listOnly ? (
        <div className="flex items-start gap-3 rounded-xl border bg-background p-4">
          <div className="min-w-0 flex-1">
            <p className="font-serif text-xl leading-7 font-medium" data-testid="selected-article">
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
            className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border-[1.5px] border-border-strong bg-surface px-3 text-sm font-medium hover:bg-accent"
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
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your articles" aria-label="Search your articles" className="pl-9" autoFocus={listOnly} />
          </div>
          <fieldset className={cn('overflow-y-auto rounded-xl border bg-background', listOnly ? 'max-h-[min(24rem,60dvh)]' : 'max-h-64')}>
            <legend className="sr-only">Choose an article</legend>
            {shown.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">No article matches “{query}”.</p>
            ) : (
              <ul className="divide-y">
                {shown.map((a) => {
                  const id = `${name}-${a.id}`;
                  return (
                    <li key={a.id}>
                      <label htmlFor={id} className={cn('flex min-h-12 cursor-pointer items-start gap-3 px-4 py-3 hover:bg-accent', a.id === selectedId && 'bg-accent')}>
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

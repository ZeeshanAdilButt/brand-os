'use client';

import { Check, Loader2, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/field';
import { AREAS, type Area } from '@/lib/directory';
import { PLATFORMS, type PlatformId } from '@/lib/catalog';
import { areaCounts, monogramOf, platformFact, rowsInArea, rowState, SHORT_AREA_LABELS, startArea, type SelectorRow } from '@/lib/publish-workspace';
import type { Recommendation } from '@/lib/recommend';
import { cn } from '@/lib/utils';

/**
 * The platform list. It opens on one category (the one with the first suggestion): category tabs that wrap rather than
 * scroll (a select on a phone), a filter that looks in every category, and plain 48px rows: a tile, the name, one real
 * fact, the state in a word, a checkbox. What is chosen is pinned at the top, so nothing is hunted for. The suggestions
 * are only shown to someone with nothing chosen and nothing connected. Choosing prepares a preview at once and sends
 * nothing. Entries that cannot get a preview or an approval stay visible with the reason and cannot be checked.
 */
export function PlatformSelector({
  rows,
  selected,
  busy,
  onToggle,
  onChooseAll,
  recommendations,
}: {
  rows: SelectorRow[];
  selected: ReadonlySet<PlatformId>;
  busy: ReadonlySet<PlatformId>;
  onToggle(platform: PlatformId): void;
  /** Choose every recommended platform that is not chosen yet, in one go. */
  onChooseAll?(platforms: PlatformId[]): void;
  /** Suggestions to show. The page passes none once something is chosen or connected. */
  recommendations: Recommendation[];
}) {
  const [area, setArea] = useState<Area>(() =>
    startArea(
      rows,
      recommendations.map((r) => r.platform),
    ),
  );
  const [query, setQuery] = useState('');
  const counts = useMemo(() => areaCounts(rows), [rows]);
  const searching = query.trim().length > 0;
  const visible = useMemo(() => rowsInArea(rows, searching ? 'all' : area, query), [rows, area, query, searching]);
  // Chosen platforms stay at the top whatever category is open; the category list shows the rest.
  const pinned = useMemo(() => (searching ? [] : rows.filter((r) => r.composer !== null && selected.has(r.composer))), [rows, selected, searching]);
  const listed = useMemo(() => (searching ? visible : visible.filter((r) => !(r.composer !== null && selected.has(r.composer)))), [visible, searching, selected]);

  return (
    <div className="grid gap-4">
      {recommendations.length > 0 ? (
        <section aria-label="Recommended for this article" className="flex flex-wrap items-center gap-2">
          <span className="mono-label mr-1 text-muted-foreground">Suggested</span>
          {recommendations.map((r) => {
            const on = selected.has(r.platform);
            return (
              <button
                key={r.platform}
                type="button"
                aria-pressed={on}
                title={r.reason}
                disabled={busy.has(r.platform)}
                onClick={() => onToggle(r.platform)}
                className={cn(
                  'inline-flex h-10 items-center gap-1.5 rounded-full border-[1.5px] px-4 text-sm font-medium transition-colors duration-[120ms] disabled:opacity-60',
                  on ? 'border-solid bg-solid text-solid-foreground' : 'border-border-strong bg-surface hover:bg-accent',
                )}
              >
                {on ? <Check aria-hidden className="size-3.5 text-solid-accent" strokeWidth={3} /> : null}
                {PLATFORMS[r.platform].name}
              </button>
            );
          })}
          {onChooseAll && recommendations.some((r) => !selected.has(r.platform)) ? (
            <button
              type="button"
              onClick={() => onChooseAll(recommendations.filter((r) => !selected.has(r.platform)).map((r) => r.platform))}
              className="inline-flex h-10 items-center rounded-full px-2 text-sm font-medium text-link underline-offset-4 hover:underline"
            >
              Choose all {recommendations.length}
            </button>
          ) : null}
        </section>
      ) : null}

      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter platforms" aria-label="Search platforms" className="pl-10" />
        </div>
        <select
          aria-label="Category"
          value={area}
          onChange={(e) => {
            setArea(e.target.value as Area);
            setQuery('');
          }}
          className="h-10 max-w-[45%] shrink-0 rounded-md border border-input bg-surface px-3 text-[0.9375rem] sm:hidden"
        >
          {AREAS.map((a) => (
            <option key={a} value={a}>
              {SHORT_AREA_LABELS[a]} {counts[a]}
            </option>
          ))}
        </select>
      </div>

      <div role="tablist" aria-label="Categories" className="-mt-1 hidden flex-wrap gap-x-5 border-b sm:flex">
        {AREAS.map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={!searching && area === a}
            onClick={() => {
              setArea(a);
              setQuery('');
            }}
            className={cn(
              '-mb-px inline-flex h-10 shrink-0 items-center gap-1.5 border-b-2 text-[0.9375rem] whitespace-nowrap transition-colors duration-[120ms]',
              !searching && area === a ? 'border-accent-warm font-semibold text-foreground' : 'border-transparent font-medium text-muted-foreground hover:text-foreground',
            )}
          >
            {SHORT_AREA_LABELS[a]}
            {counts[a] > 0 ? <span className="font-mono text-xs font-normal text-muted-foreground">{counts[a]}</span> : null}
          </button>
        ))}
      </div>

      <fieldset className="-mx-2 min-w-0">
        <legend className="sr-only">Platforms</legend>
        {pinned.length > 0 ? (
          <>
            <p className="mono-label px-3 pb-1 text-muted-foreground">Chosen</p>
            <ul className="mb-3 grid grid-cols-[minmax(0,1fr)] gap-0.5">
              {pinned.map((row) => (
                <SelectorItem key={row.entry.id} row={row} checked working={row.composer ? busy.has(row.composer) : false} onToggle={onToggle} />
              ))}
            </ul>
            {listed.length > 0 ? <p className="mono-label px-3 pb-1 text-muted-foreground">{SHORT_AREA_LABELS[area]}</p> : null}
          </>
        ) : null}
        {visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches that filter.</p>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
            {listed.map((row) => (
              <SelectorItem key={row.entry.id} row={row} checked={row.composer ? selected.has(row.composer) : false} working={row.composer ? busy.has(row.composer) : false} onToggle={onToggle} />
            ))}
          </ul>
        )}
      </fieldset>
    </div>
  );
}

function SelectorItem({ row, checked, working, onToggle }: { row: SelectorRow; checked: boolean; working: boolean; onToggle(platform: PlatformId): void }) {
  const { entry } = row;
  const id = `sel-${entry.id}`;
  const blocked = row.composer === null;
  const state = rowState(row);
  const tile = monogramOf(entry.name);
  return (
    <li>
      <label
        htmlFor={id}
        className={cn(
          'group flex min-h-12 items-center gap-3 rounded-xl px-3 py-1.5 transition-colors duration-[120ms] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
          blocked ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-accent',
          checked && 'bg-accent',
        )}
      >
        <span aria-hidden className={cn('grid size-8 shrink-0 place-items-center rounded-lg font-mono text-xs font-medium', checked ? 'bg-solid text-solid-foreground' : 'bg-secondary text-foreground', blocked && 'opacity-60')}>
          {tile}
        </span>
        <span className="min-w-0 flex-1">
          <span id={`${id}-name`} className={cn('block truncate text-[0.9375rem] leading-5 font-semibold', blocked && 'text-muted-foreground')}>
            {entry.name}
          </span>
          <span id={`${id}-why`} className="block truncate text-[0.8125rem] leading-5 text-muted-foreground">
            {platformFact(row)}
          </span>
        </span>
        {working ? <Loader2 aria-label="Preparing" className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" /> : null}
        {state.label && !working ? (
          <span className="flex shrink-0 items-center">
            <span className={cn('font-mono text-xs group-focus-within:hidden group-hover:hidden [@media(hover:none)]:hidden', state.attention ? 'text-accent-warm' : 'text-muted-foreground')}>{state.label}</span>
            {state.attention ? (
              <Link
                href={`/platforms/integrations#${entry.id}`}
                aria-label={`Connect ${entry.name}`}
                className="hidden h-10 items-center rounded-lg border-[1.5px] border-border-strong bg-surface px-3 text-sm font-medium text-foreground group-focus-within:inline-flex group-hover:inline-flex hover:bg-secondary [@media(hover:none)]:hidden"
              >
                Connect
              </Link>
            ) : null}
          </span>
        ) : null}
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={blocked || working}
          aria-labelledby={`${id}-name`}
          aria-describedby={`${id}-why`}
          onChange={() => row.composer && onToggle(row.composer)}
          className="peer sr-only"
        />
        <span
          aria-hidden
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded-[0.4375rem] border-[1.5px] border-border-strong transition-colors duration-[120ms] peer-disabled:border-border peer-disabled:opacity-60',
            checked ? 'bg-solid' : 'bg-surface',
          )}
        >
          {checked ? <Check className="size-3.5 text-solid-accent" strokeWidth={3} /> : null}
        </span>
      </label>
    </li>
  );
}

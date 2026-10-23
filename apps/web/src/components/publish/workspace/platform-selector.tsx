'use client';

import { Check, Loader2, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/field';
import { AREAS, METHOD_LABELS, type Area } from '@/lib/directory';
import { PLATFORMS, type PlatformId } from '@/lib/catalog';
import { areaCounts, monogramOf, rowsInArea, rowState, SHORT_AREA_LABELS, startArea, type SelectorRow } from '@/lib/publish-workspace';
import type { Recommendation } from '@/lib/recommend';
import { cn } from '@/lib/utils';

const MODE_TEXT = { publish: 'Preview and publish from Brand OS', manual: 'Preview here, post by hand', none: '' } as const;

/**
 * Where should it go? A compact multi-select over the whole directory. It opens on one category (the one with the first
 * suggestion), with the suggestions above as one row of chips, category tabs with counts, and a plain list of rows:
 * a tile, the name, one fact, the state in a word, a checkbox. Searching looks in every category. Choosing prepares a
 * preview at once and sends nothing. Entries that cannot get a preview or an approval stay visible with the reason and
 * cannot be checked.
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
  const chosenIn = useMemo(() => {
    const n: Partial<Record<Area, number>> = {};
    for (const row of rows) if (row.composer && selected.has(row.composer)) n[row.entry.area] = (n[row.entry.area] ?? 0) + 1;
    return n;
  }, [rows, selected]);

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
                  'inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] px-3.5 text-sm font-medium transition-colors duration-[120ms] disabled:opacity-60',
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
              className="inline-flex h-9 items-center rounded-full px-2 text-sm font-medium text-link underline-offset-4 hover:underline"
            >
              Choose all {recommendations.length}
            </button>
          ) : null}
        </section>
      ) : null}

      <div role="tablist" aria-label="Categories" className="-mx-1 flex gap-5 overflow-x-auto overflow-y-hidden border-b px-1 [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
              '-mb-px inline-flex h-11 shrink-0 items-center gap-1.5 border-b-2 text-[0.9375rem] whitespace-nowrap transition-colors duration-[120ms]',
              !searching && area === a ? 'border-accent-warm font-semibold text-foreground' : 'border-transparent font-medium text-muted-foreground hover:text-foreground',
            )}
          >
            {SHORT_AREA_LABELS[a]}
            <span className="font-mono text-xs font-normal text-muted-foreground">{counts[a]}</span>
            {chosenIn[a] ? (
              <span className="grid min-w-5 place-items-center rounded-full bg-solid px-1.5 font-mono text-[0.6875rem] leading-5 text-solid-accent" title={`${chosenIn[a]} chosen`}>
                <span aria-hidden>{chosenIn[a]}</span>
                <span className="sr-only">{chosenIn[a]} chosen</span>
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search every platform" aria-label="Search platforms" className="pl-10" />
      </div>

      <fieldset className="-mx-2">
        <legend className="sr-only">Platforms</legend>
        {visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches that search.</p>
        ) : (
          <ul className="grid gap-0.5">
            {visible.map((row) => (
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
  return (
    <li>
      <label
        htmlFor={id}
        className={cn(
          'flex min-h-16 items-center gap-3.5 rounded-xl px-3 py-2.5 transition-colors duration-[120ms] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
          blocked ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-accent',
          checked && 'bg-accent',
        )}
      >
        <span
          aria-hidden
          className={cn('mono-label grid size-10 shrink-0 place-items-center rounded-xl text-[0.8125rem] tracking-[0.03em] normal-case', checked ? 'bg-solid text-solid-foreground' : 'bg-secondary text-foreground', blocked && 'opacity-60')}
        >
          {monogramOf(entry.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span id={`${id}-name`} className={cn('block text-base leading-6 font-semibold', blocked && 'text-muted-foreground')}>
            {entry.name}
          </span>
          <span id={`${id}-why`} className="mt-0.5 block text-sm leading-5 text-muted-foreground">
            {row.blockedReason ?? MODE_TEXT[row.mode]}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          <span className={cn('mono-label', state.attention ? 'text-accent-warm' : 'text-muted-foreground')}>
            {working ? <Loader2 aria-label="Preparing" className="inline size-3.5 animate-spin motion-reduce:animate-none" /> : state.label}
          </span>
          <span className="mono-label hidden text-[0.625rem] text-muted-foreground/80 sm:block" title={`How it gets there: ${METHOD_LABELS[entry.method]}`}>
            {METHOD_LABELS[entry.method]}
          </span>
        </span>
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

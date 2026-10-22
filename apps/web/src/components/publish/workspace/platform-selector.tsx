'use client';

import { Check, Loader2, Search, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AREA_STYLE } from '@/components/platforms/area-style';
import { Input } from '@/components/ui/field';
import { StatusChip } from '@/components/ui/status-chip';
import { directoryChip } from '@/lib/chips';
import { AREAS, AREA_LABELS, type Area } from '@/lib/directory';
import { PLATFORMS, type PlatformId } from '@/lib/catalog';
import { rowsInArea, type SelectorRow } from '@/lib/publish-workspace';
import type { Recommendation } from '@/lib/recommend';
import { cn } from '@/lib/utils';

const MODE_TEXT = { publish: 'Preview and publish from Brand OS', manual: 'Preview here, post by hand', none: '' } as const;

/**
 * Area 2: choose platforms. A compact multi-select over the whole directory, with category tabs, search and
 * "Recommended for this article". Choosing prepares a preview at once and sends nothing. Entries that cannot get a
 * preview or an approval are visible with the reason and cannot be checked.
 */
export function PlatformSelector({
  rows,
  selected,
  busy,
  onToggle,
  recommendations,
}: {
  rows: SelectorRow[];
  selected: ReadonlySet<PlatformId>;
  busy: ReadonlySet<PlatformId>;
  onToggle(platform: PlatformId): void;
  recommendations: Recommendation[];
}) {
  const [area, setArea] = useState<Area | 'all'>('all');
  const [query, setQuery] = useState('');
  const visible = useMemo(() => rowsInArea(rows, area, query), [rows, area, query]);

  return (
    <div className="grid gap-3">
      {recommendations.length > 0 ? (
        <section aria-labelledby="rec-heading" className="rounded-lg bg-accent px-3 py-2.5">
          <h3 id="rec-heading" className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles aria-hidden className="size-4 text-primary" />
            Recommended for this article
          </h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {recommendations.map((r) => {
              const on = selected.has(r.platform);
              return (
                <li key={r.platform}>
                  <button
                    type="button"
                    aria-pressed={on}
                    title={r.reason}
                    disabled={busy.has(r.platform)}
                    onClick={() => onToggle(r.platform)}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors duration-[120ms] disabled:opacity-60',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-surface hover:bg-accent',
                    )}
                  >
                    {on ? <Check aria-hidden className="size-3.5" /> : null}
                    {PLATFORMS[r.platform].name}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div role="tablist" aria-label="Categories" className="-mx-1 flex gap-1 overflow-x-auto border-b px-1">
        {(['all', ...AREAS] as const).map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={area === a}
            onClick={() => setArea(a)}
            className={cn(
              '-mb-px inline-flex h-10 shrink-0 items-center border-b-2 px-3 text-sm transition-colors duration-[120ms]',
              area === a ? 'border-primary font-semibold text-foreground' : 'border-transparent font-medium text-muted-foreground hover:text-foreground',
            )}
          >
            {a === 'all' ? 'All' : AREA_LABELS[a]}
          </button>
        ))}
      </div>

      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search platforms" aria-label="Search platforms" className="pl-9" />
      </div>

      <fieldset className="max-h-[26rem] overflow-y-auto rounded-lg border bg-background">
        <legend className="sr-only">Platforms</legend>
        {visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches that search.</p>
        ) : (
          <ul className="divide-y">
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
  const Icon = AREA_STYLE[entry.area].icon;
  const id = `sel-${entry.id}`;
  const blocked = row.composer === null;
  return (
    <li className={cn('flex items-start gap-3 px-3 py-2.5', checked && 'bg-accent')}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={blocked || working}
        aria-describedby={`${id}-why`}
        onChange={() => row.composer && onToggle(row.composer)}
        className="mt-1 size-4 shrink-0 accent-[var(--primary)] disabled:cursor-not-allowed"
      />
      <label htmlFor={id} className={cn('flex min-w-0 flex-1 items-start gap-2', blocked ? 'cursor-not-allowed' : 'cursor-pointer')}>
        <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', AREA_STYLE[entry.area].text)} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn('text-sm leading-5 font-medium', blocked && 'text-muted-foreground')}>{entry.name}</span>
            <StatusChip chip={directoryChip(row.status, entry.roadmap)} />
            {working ? <Loader2 aria-label="Preparing" className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" /> : null}
          </span>
          <span id={`${id}-why`} className="mt-0.5 block text-xs leading-5 text-muted-foreground">
            {row.blockedReason ?? MODE_TEXT[row.mode]}
          </span>
        </span>
      </label>
    </li>
  );
}

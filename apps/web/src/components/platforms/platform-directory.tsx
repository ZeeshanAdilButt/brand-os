'use client';

import { ArrowUpRight, ChevronDown, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useViewPrefs } from '@/components/shell/view-prefs';
import { buttonVariants } from '@/components/ui/button';
import { DensityToggle } from '@/components/ui/density-toggle';
import { Input, Label, Select } from '@/components/ui/field';
import { StatusChip } from '@/components/ui/status-chip';
import { directoryChip } from '@/lib/chips';
import { AREAS, AREA_BLURBS, AREA_LABELS, METHOD_HINTS, METHOD_LABELS, statusLine, type Area, type DirectoryEntry, type DirectoryStatus } from '@/lib/directory';
import type { Density } from '@/lib/view-prefs';
import { cn } from '@/lib/utils';
import { AREA_STYLE } from './area-style';
import { CategoryColumn, type CategoryOption } from './category-column';

export interface DirectoryItem {
  entry: DirectoryEntry;
  status: DirectoryStatus;
  /** Who the connection belongs to, when connected. */
  who: string | null;
}

type Filter = 'all' | 'connected' | 'api' | 'manual' | 'preview' | 'planned';

const FILTER_LABELS: Record<Filter, string> = {
  all: 'Any availability',
  connected: 'Connected',
  api: 'Publishes from Brand OS',
  manual: 'Manual posting',
  preview: 'Preview only',
  planned: 'Planned',
};

const FILTER_MATCH: Record<Filter, (item: DirectoryItem) => boolean> = {
  all: () => true,
  connected: (i) => i.status === 'available_now',
  api: (i) => i.entry.adapter,
  manual: (i) => i.status === 'manual_only',
  preview: (i) => i.status === 'preview_only' || (i.entry.composer !== null && !i.entry.adapter),
  planned: (i) => i.status === 'planned',
};

/** One short line about what Brand OS can do with this platform, apart from the state of the account. */
function capability(item: DirectoryItem): string {
  if (item.entry.adapter) return 'Publish through Brand OS';
  if (item.status === 'planned') return 'Planned';
  return 'Prepare here, post manually';
}

function Actions({ item }: { item: DirectoryItem }) {
  const { entry, status } = item;
  return (
    <>
      {status === 'available_now' ? (
        <Link href="/publishing" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
          Share an article
        </Link>
      ) : status === 'needs_connection' ? (
        <Link href={`/platforms/integrations#${entry.id}`} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
          Connect
        </Link>
      ) : status === 'preview_only' || status === 'manual_only' ? (
        <Link href="/publishing" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
          {entry.composer ? 'Preview an article' : 'See how it works'}
        </Link>
      ) : (
        <span className={buttonVariants({ size: 'sm', variant: 'outline', className: 'pointer-events-none cursor-not-allowed text-muted-foreground' })} aria-disabled="true">
          {entry.roadmap ?? 'Planned'}
        </span>
      )}
      <Link href={`/platforms/integrations#${entry.id}`} className={buttonVariants({ size: 'sm', variant: 'ghost' })}>
        Account setup
      </Link>
    </>
  );
}

/** One platform as a single row: the name, what it can do, a line about it, its state and the next step. */
function PlatformRow({ item }: { item: DirectoryItem }) {
  const { entry, status } = item;
  const area = AREA_STYLE[entry.area];
  const Icon = area.icon;
  return (
    <li id={entry.id} className="flex scroll-mt-24 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-surface px-4 py-3">
      <span aria-hidden className={cn('grid size-8 shrink-0 place-items-center rounded-lg bg-muted', area.text)}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 basis-44">
        <h3 className="truncate text-base leading-6 font-semibold">{entry.name}</h3>
        <p className="truncate text-sm text-muted-foreground">{item.who ? `Connected as ${item.who}` : capability(item)}</p>
      </div>
      <p className="hidden min-w-0 flex-1 basis-64 text-sm leading-6 text-muted-foreground md:line-clamp-2 md:block">{entry.summary}</p>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <StatusChip chip={directoryChip(status, entry.roadmap)} />
        <Actions item={item} />
      </div>
    </li>
  );
}

function PlatformCard({ item, compact }: { item: DirectoryItem; compact: boolean }) {
  const { entry, status } = item;
  const area = AREA_STYLE[entry.area];
  const Icon = area.icon;
  const chip = directoryChip(status, entry.roadmap);
  return (
    <li id={entry.id} className={cn('flex scroll-mt-24 flex-col rounded-xl border bg-surface', compact ? 'p-3.5' : 'p-5')}>
      <div className="flex items-start gap-3">
        <span aria-hidden className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted', area.text)}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base leading-6 font-semibold">{entry.name}</h3>
          <p className="text-sm text-muted-foreground">{capability(item)}</p>
        </div>
        <StatusChip chip={chip} />
      </div>
      <p className={cn('mt-3 text-sm leading-6', compact && 'line-clamp-2')}>{entry.summary}</p>
      {item.who ? <p className="mt-2 text-sm text-muted-foreground">Connected as {item.who}</p> : null}
      <details className={cn('group mt-3 text-sm', compact && 'hidden')}>
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 font-medium text-link">
          <ChevronDown aria-hidden className="size-4 transition-transform duration-[120ms] group-open:rotate-180" />
          Details
        </summary>
        <div className="mt-3 grid gap-3 text-sm leading-6">
          <p className="text-muted-foreground">{statusLine(entry, status)}</p>
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Setup</dt>
            <dd title={METHOD_HINTS[entry.method]}>{METHOD_LABELS[entry.method]}</dd>
            <dt className="text-muted-foreground">Plan</dt>
            <dd>{entry.plan}</dd>
            <dt className="text-muted-foreground">Cost</dt>
            <dd>{entry.cost}</dd>
          </dl>
          {entry.restrictions.length > 0 ? (
            <ul className="grid gap-1 pl-4">
              {entry.restrictions.map((r) => (
                <li key={r} className="list-disc">
                  {r}
                </li>
              ))}
            </ul>
          ) : null}
          {entry.unverified.length > 0 ? (
            <div>
              <p className="font-medium">Not verified yet</p>
              <ul className="grid gap-1 pl-4">
                {entry.unverified.map((u) => (
                  <li key={u} className="list-disc text-muted-foreground">
                    {u}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <a href={entry.url} target="_blank" rel="noreferrer noopener" className="inline-flex w-fit items-center gap-1 font-medium text-link underline underline-offset-2">
            Official site
            <ArrowUpRight aria-hidden className="size-4" />
          </a>
        </div>
      </details>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        <Actions item={item} />
      </div>
    </li>
  );
}

/** Every platform, grouped by category. One search box and two selects; planned platforms stay visible with readable text. */
export function PlatformDirectory({ items, initialArea }: { items: DirectoryItem[]; initialArea?: Area | null }) {
  const [area, setArea] = useState<Area | 'all'>(initialArea ?? 'all');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const { prefs, update } = useViewPrefs();
  const density = prefs.platformsDensity;

  const visible = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((item) => {
      if (area !== 'all' && item.entry.area !== area) return false;
      if (!FILTER_MATCH[filter](item)) return false;
      const hay = `${item.entry.name} ${item.entry.summary} ${item.entry.id} ${AREA_LABELS[item.entry.area]}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [items, area, query, filter]);

  const byArea = items.filter((item) => {
    const words = query.toLowerCase().split(/s+/).filter(Boolean);
    const hay = `${item.entry.name} ${item.entry.summary} ${item.entry.id} ${AREA_LABELS[item.entry.area]}`.toLowerCase();
    return FILTER_MATCH[filter](item) && words.every((w) => hay.includes(w));
  });
  const categories: CategoryOption[] = [{ id: 'all', label: 'All categories', count: byArea.length }, ...AREAS.map((a) => ({ id: a, label: AREA_LABELS[a], count: byArea.filter((i) => i.entry.area === a).length }))];
  const grouped = AREAS.map((a) => ({ area: a, items: visible.filter((i) => i.entry.area === a) })).filter((g) => g.items.length > 0);
  const filtered = Boolean(query) || filter !== 'all' || area !== 'all';

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-52 flex-1 gap-1.5 md:basis-64">
          <Label htmlFor="dir-search">Search</Label>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input id="dir-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search platforms" className="pl-9" />
          </div>
        </div>
        <div className="grid w-full gap-1.5 sm:w-56">
          <Label htmlFor="dir-filter">Availability</Label>
          <Select id="dir-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
              <option key={f} value={f}>
                {FILTER_LABELS[f]}
              </option>
            ))}
          </Select>
        </div>
        <DensityToggle value={density} onChange={(value) => update({ platformsDensity: value })} label="Layout of the platform list" />
      </div>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {visible.length} {visible.length === 1 ? 'platform' : 'platforms'}
        {filtered ? ' match' : ''}. Brand OS publishes to DEV.to, Hashnode and your own site today. The rest are previews, manual posting or planned.
        {filtered ? (
          <>
            {' '}
            <button
              type="button"
              className="font-medium text-link underline underline-offset-2"
              onClick={() => {
                setQuery('');
                setArea('all');
                setFilter('all');
              }}
            >
              Clear filters
            </button>
          </>
        ) : null}
      </p>

      <div className={cn('grid items-start gap-4 lg:gap-6', prefs.filtersCollapsed ? 'lg:grid-cols-[3rem_minmax(0,1fr)]' : 'lg:grid-cols-[13.5rem_minmax(0,1fr)]')}>
        <CategoryColumn options={categories} value={area} onChange={(id) => setArea(id as Area | 'all')} collapsed={prefs.filtersCollapsed} onCollapsedChange={(c) => update({ filtersCollapsed: c })} />
        <div className="min-w-0">
      {grouped.length === 0 ? (
        <section className="rounded-xl border bg-surface p-8 text-center">
          <h2 className="text-lg font-semibold">Nothing matches</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">No platform fits that search and those filters.</p>
          <button
            type="button"
            className={buttonVariants({ variant: 'outline', className: 'mt-4' })}
            onClick={() => {
              setQuery('');
              setArea('all');
              setFilter('all');
            }}
          >
            Clear filters
          </button>
        </section>
      ) : (
        grouped.map((g) => (
          <section key={g.area} className="mb-8 last:mb-0" aria-labelledby={`area-${g.area}`}>
            <h2 id={`area-${g.area}`} className="text-lg font-semibold">
              {AREA_LABELS[g.area]}
            </h2>
            <p className="mt-0.5 mb-4 text-sm text-muted-foreground">{AREA_BLURBS[g.area]}</p>
            <ul className={cn('grid', density === 'list' ? 'gap-2' : density === 'compact' ? 'gap-3 sm:grid-cols-2 xl:grid-cols-3' : 'gap-4 md:grid-cols-2')}>
              {g.items.map((item) => (density === 'list' ? <PlatformRow key={item.entry.id} item={item} /> : <PlatformCard key={item.entry.id} item={item} compact={density === 'compact'} />))}
            </ul>
          </section>
        ))
      )}
        </div>
      </div>
    </div>
  );
}

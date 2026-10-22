'use client';

import { ArrowUpRight, ChevronDown, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/field';
import { StatusChip } from '@/components/ui/status-chip';
import { directoryChip } from '@/lib/chips';
import { AREAS, AREA_BLURBS, AREA_LABELS, METHOD_HINTS, METHOD_LABELS, statusLine, type Area, type DirectoryEntry, type DirectoryStatus } from '@/lib/directory';
import { cn } from '@/lib/utils';
import { AREA_STYLE } from './area-style';

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

function PlatformCard({ item }: { item: DirectoryItem }) {
  const { entry, status } = item;
  const area = AREA_STYLE[entry.area];
  const Icon = area.icon;
  const chip = directoryChip(status, entry.roadmap);
  return (
    <li id={entry.id} className="flex scroll-mt-24 flex-col rounded-xl border bg-surface p-5">
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
      <p className="mt-3 text-sm leading-6">{entry.summary}</p>
      {item.who ? <p className="mt-2 text-sm text-muted-foreground">Connected as {item.who}</p> : null}
      <details className="group mt-3 text-sm">
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
      </div>
    </li>
  );
}

/** Every platform, grouped by category. One search box and two selects; planned platforms stay visible with readable text. */
export function PlatformDirectory({ items, initialArea }: { items: DirectoryItem[]; initialArea?: Area | null }) {
  const [area, setArea] = useState<Area | 'all'>(initialArea ?? 'all');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const visible = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((item) => {
      if (area !== 'all' && item.entry.area !== area) return false;
      if (!FILTER_MATCH[filter](item)) return false;
      const hay = `${item.entry.name} ${item.entry.summary} ${item.entry.id} ${AREA_LABELS[item.entry.area]}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [items, area, query, filter]);

  const grouped = AREAS.map((a) => ({ area: a, items: visible.filter((i) => i.entry.area === a) })).filter((g) => g.items.length > 0);
  const filtered = Boolean(query) || filter !== 'all' || area !== 'all';

  return (
    <div className="grid gap-6">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_14rem]">
        <div className="grid gap-1.5">
          <Label htmlFor="dir-search">Search</Label>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input id="dir-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search platforms" className="pl-9" />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="dir-area">Category</Label>
          <Select id="dir-area" value={area} onChange={(e) => setArea(e.target.value as Area | 'all')}>
            <option value="all">All categories</option>
            {AREAS.map((a) => (
              <option key={a} value={a}>
                {AREA_LABELS[a]}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="dir-filter">Availability</Label>
          <Select id="dir-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
              <option key={f} value={f}>
                {FILTER_LABELS[f]}
              </option>
            ))}
          </Select>
        </div>
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
          <section key={g.area} aria-labelledby={`area-${g.area}`}>
            <h2 id={`area-${g.area}`} className="text-lg font-semibold">
              {AREA_LABELS[g.area]}
            </h2>
            <p className="mt-0.5 mb-4 text-sm text-muted-foreground">{AREA_BLURBS[g.area]}</p>
            <ul className="grid gap-4 md:grid-cols-2">
              {g.items.map((item) => (
                <PlatformCard key={item.entry.id} item={item} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

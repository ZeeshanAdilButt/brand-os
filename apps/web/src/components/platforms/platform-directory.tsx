'use client';

import { ArrowUpRight, ChevronDown, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
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

const FILTER_MATCH: Record<Filter, (item: DirectoryItem) => boolean> = {
  all: () => true,
  connected: (i) => i.status === 'available_now',
  api: (i) => i.entry.adapter,
  manual: (i) => i.status === 'manual_only',
  preview: (i) => i.status === 'preview_only' || (i.entry.composer !== null && !i.entry.adapter),
  planned: (i) => i.status === 'planned',
};

function PlatformCard({ item }: { item: DirectoryItem }) {
  const { entry, status } = item;
  const area = AREA_STYLE[entry.area];
  const Icon = area.icon;
  const chip = directoryChip(status, entry.roadmap);
  const disabled = status === 'planned';
  return (
    <li id={entry.id} className={cn('flex scroll-mt-24 flex-col rounded-xl border bg-surface p-4', disabled && 'border-dashed')}>
      <div className="flex items-start gap-3">
        <span aria-hidden className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted', area.text)}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base leading-6 font-semibold">{entry.name}</h3>
          <div className="mt-1">
            <StatusChip chip={chip} />
          </div>
        </div>
      </div>
      <p className="mt-3 text-sm leading-6">{entry.summary}</p>
      <dl className="mt-3 grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 text-xs leading-5">
        <dt className="text-muted-foreground">Method</dt>
        <dd title={METHOD_HINTS[entry.method]}>{METHOD_LABELS[entry.method]}</dd>
        <dt className="text-muted-foreground">Plan</dt>
        <dd>{entry.plan}</dd>
        {item.who ? (
          <>
            <dt className="text-muted-foreground">Connected as</dt>
            <dd>{item.who}</dd>
          </>
        ) : null}
      </dl>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">{statusLine(entry, status)}</p>
      <details className="group mt-3 text-xs">
        <summary className="flex cursor-pointer list-none items-center gap-1 font-medium text-link">
          <ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180" />
          Limits, costs and open questions
        </summary>
        <div className="mt-2 grid gap-2 leading-5">
          {entry.restrictions.length > 0 ? (
            <ul className="grid gap-1 pl-4">
              {entry.restrictions.map((r) => (
                <li key={r} className="list-disc">
                  {r}
                </li>
              ))}
            </ul>
          ) : null}
          <p>
            <span className="font-medium">Cost:</span> {entry.cost}
          </p>
          {entry.unverified.length > 0 ? (
            <div>
              <p className="font-medium">Not verified</p>
              <ul className="grid gap-1 pl-4">
                {entry.unverified.map((u) => (
                  <li key={u} className="list-disc text-muted-foreground">
                    {u}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </details>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        {status === 'available_now' ? (
          <Link href="/articles" className={buttonVariants({ size: 'sm' })}>
            Share an article
          </Link>
        ) : status === 'needs_connection' ? (
          <Link href={`/platforms/integrations#${entry.id}`} className={buttonVariants({ size: 'sm' })}>
            Connect
          </Link>
        ) : status === 'preview_only' || status === 'manual_only' ? (
          <Link href="/articles" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
            {entry.composer ? 'Preview an article here' : 'See how it works'}
          </Link>
        ) : (
          <span className={buttonVariants({ size: 'sm', variant: 'outline', className: 'pointer-events-none cursor-not-allowed text-muted-foreground' })} aria-disabled="true">
            {entry.roadmap ?? 'Planned'}
          </span>
        )}
        <Link href={`/platforms/integrations#${entry.id}`} className={buttonVariants({ size: 'sm', variant: 'ghost' })}>
          Setup
        </Link>
        <a href={entry.url} target="_blank" rel="noreferrer noopener" className={buttonVariants({ size: 'sm', variant: 'ghost' })}>
          Official site
          <ArrowUpRight aria-hidden />
        </a>
      </div>
    </li>
  );
}

/** Every platform, by area. Search, area tabs and a status filter; planned platforms stay visible, dashed and disabled. */
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

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: items.length };
    for (const a of AREAS) out[a] = items.filter((i) => i.entry.area === a).length;
    return out;
  }, [items]);

  const grouped = AREAS.map((a) => ({ area: a, items: visible.filter((i) => i.entry.area === a) })).filter((g) => g.items.length > 0);

  return (
    <div className="grid gap-5">
      <div role="tablist" aria-label="Categories" className="flex flex-wrap gap-1.5">
        {(['all', ...AREAS] as const).map((a) => {
          const selected = area === a;
          return (
            <button
              key={a}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setArea(a)}
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors duration-[120ms]',
                selected ? 'border-primary bg-accent text-accent-foreground' : 'border-border bg-surface text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {a === 'all' ? 'All' : AREA_LABELS[a]}
              <span className="rounded-full bg-muted px-1.5 text-xs">{counts[a]}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative lg:w-96">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search platforms" aria-label="Search platforms" className="pl-9" />
        </div>
        <div className="overflow-x-auto">
          <Segmented<Filter>
            label="Filter by status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'Everything' },
              { value: 'connected', label: 'Connected' },
              { value: 'api', label: 'Publishes' },
              { value: 'manual', label: 'Manual' },
              { value: 'preview', label: 'Preview' },
              { value: 'planned', label: 'Planned' },
            ]}
          />
        </div>
      </div>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {visible.length} {visible.length === 1 ? 'platform' : 'platforms'}
        {query || filter !== 'all' || area !== 'all' ? ' match' : ''}. Only DEV.to, Hashnode and your own site can be published to today; the rest are previews, manual posting or planned.
      </p>

      {grouped.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Nothing matches. Clear the search or choose another category.</p>
      ) : (
        grouped.map((g) => (
          <section key={g.area} aria-labelledby={`area-${g.area}`}>
            <h2 id={`area-${g.area}`} className="text-lg font-semibold">
              {AREA_LABELS[g.area]}
            </h2>
            <p className="mt-0.5 mb-3 text-sm text-muted-foreground">{AREA_BLURBS[g.area]}</p>
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
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

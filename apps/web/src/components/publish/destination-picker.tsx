'use client';

import { Check, Search, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AREA_STYLE } from '@/components/platforms/area-style';
import { Input } from '@/components/ui/field';
import { StatusChip } from '@/components/ui/status-chip';
import { directoryChip } from '@/lib/chips';
import { AREAS, AREA_LABELS, DIRECTORY, METHOD_LABELS, directoryStatus, statusLine, type Area, type DirectoryEntry } from '@/lib/directory';
import { PLATFORMS, type PlatformId } from '@/lib/catalog';
import type { Recommendation } from '@/lib/recommend';
import type { DestinationDTO } from '@/lib/publishing';
import { cn } from '@/lib/utils';

/**
 * Step 1: where should this article go? Every platform in the directory is shown, grouped by category tabs, with
 * search and "Recommended for this article" chips. Platforms that cannot be chosen yet stay visible with the reason.
 * Choosing sends nothing: it only decides which versions to prepare.
 */
export function DestinationPicker({
  destinations,
  selected,
  onToggle,
  recommendations,
}: {
  destinations: DestinationDTO[];
  selected: ReadonlySet<PlatformId>;
  onToggle(platform: PlatformId): void;
  recommendations: Recommendation[];
}) {
  const [area, setArea] = useState<Area | 'all'>('all');
  const [query, setQuery] = useState('');
  const dest = useMemo(() => new Map(destinations.map((d) => [d.platform, d])), [destinations]);

  const visible = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return DIRECTORY.filter((e) => (area === 'all' || e.area === area) && words.every((w) => `${e.name} ${e.id} ${e.summary}`.toLowerCase().includes(w)));
  }, [area, query]);

  return (
    <div className="grid gap-5">
      {recommendations.length > 0 ? (
        <section aria-labelledby="rec-heading" className="rounded-xl border bg-accent/50 p-3 sm:p-4">
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
                    onClick={() => onToggle(r.platform)}
                    title={r.reason}
                    className={cn(
                      'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors duration-[120ms]',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-surface hover:bg-muted',
                    )}
                  >
                    {on ? <Check aria-hidden className="size-4" /> : null}
                    {PLATFORMS[r.platform].name}
                  </button>
                </li>
              );
            })}
          </ul>
          <ul className="mt-2 grid gap-0.5 text-xs leading-5 text-muted-foreground">
            {recommendations.map((r) => (
              <li key={r.platform}>
                <span className="font-medium text-foreground">{PLATFORMS[r.platform].name}:</span> {r.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div role="tablist" aria-label="Categories" className="flex flex-wrap gap-1.5">
        {(['all', ...AREAS] as const).map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={area === a}
            onClick={() => setArea(a)}
            className={cn(
              'inline-flex h-9 items-center rounded-lg border px-3 text-sm font-medium transition-colors duration-[120ms]',
              area === a ? 'border-primary bg-accent text-accent-foreground' : 'border-border bg-surface text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {a === 'all' ? 'All' : AREA_LABELS[a]}
          </button>
        ))}
      </div>

      <div className="relative sm:w-96">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search platforms" aria-label="Search platforms" className="pl-9" />
      </div>

      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((entry) => (
          <PickerCard key={entry.id} entry={entry} destination={entry.composer ? dest.get(entry.composer) : undefined} checked={entry.composer ? selected.has(entry.composer) : false} onToggle={onToggle} />
        ))}
      </ul>
      {visible.length === 0 ? <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">Nothing matches that search.</p> : null}
    </div>
  );
}

function PickerCard({ entry, destination, checked, onToggle }: { entry: DirectoryEntry; destination: DestinationDTO | undefined; checked: boolean; onToggle(platform: PlatformId): void }) {
  const style = AREA_STYLE[entry.area];
  const Icon = style.icon;
  const connected = destination?.connection?.status === 'connected';
  const status = directoryStatus(entry, connected);
  const selectable = Boolean(entry.composer && destination);
  const id = `pick-${entry.id}`;
  const prepared = destination?.draft ?? null;

  return (
    <li className={cn('relative flex flex-col rounded-xl border bg-surface p-3.5 transition-colors duration-[120ms]', checked && 'border-primary bg-accent/40', !selectable && 'border-dashed')}>
      <div className="flex items-start gap-3">
        <span aria-hidden className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted', style.text)}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className={cn('block text-base leading-6 font-semibold', selectable ? 'cursor-pointer' : 'cursor-not-allowed text-muted-foreground')}>
            {entry.name}
          </label>
          <p className="text-xs text-muted-foreground">
            {AREA_LABELS[entry.area]} · {entry.composer ? (PLATFORMS[entry.composer].kind === 'short_form' ? 'Short post' : PLATFORMS[entry.composer].kind === 'link_submission' ? 'Link' : PLATFORMS[entry.composer].kind === 'video' ? 'Video' : 'Article') : METHOD_LABELS[entry.method]}
          </p>
        </div>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={!selectable}
          onChange={() => entry.composer && onToggle(entry.composer)}
          className="mt-1 size-5 shrink-0 accent-[var(--primary)] disabled:cursor-not-allowed"
          aria-describedby={`${id}-why`}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <StatusChip chip={directoryChip(status, entry.roadmap)} />
        {prepared ? <span className="text-xs text-muted-foreground">Already prepared</span> : null}
      </div>
      <p id={`${id}-why`} className="mt-2 text-xs leading-5 text-muted-foreground">
        {selectable ? statusLine(entry, status) : `${statusLine(entry, status)} It stays here so you can see what is coming.`}
      </p>
      {connected && destination?.connection?.who ? <p className="mt-1 text-xs text-muted-foreground">Connected as {destination.connection.who}</p> : null}
      {selectable && status === 'needs_connection' ? (
        <a href={`/platforms/integrations#${entry.id}`} target="_blank" rel="noreferrer noopener" className="mt-2 w-fit text-xs font-medium text-link underline underline-offset-2">
          Connect in a new tab (optional: you can still prepare and post by hand)
        </a>
      ) : null}
    </li>
  );
}

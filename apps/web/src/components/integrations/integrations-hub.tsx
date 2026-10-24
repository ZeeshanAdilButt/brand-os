'use client';

import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AREA_STYLE } from '@/components/platforms/area-style';
import { CategoryColumn, type CategoryOption } from '@/components/platforms/category-column';
import { useViewPrefs } from '@/components/shell/view-prefs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { StatusChip } from '@/components/ui/status-chip';
import { connectorChip } from '@/lib/chips';
import { AUTH_KIND_LABELS, connectorFor } from '@/lib/connectors';
import type { ConnectorViewDTO } from '@/lib/connectors/dto';
import { overviewGroup } from '@/lib/connectors/state';
import { AREAS, AREA_BLURBS, AREA_LABELS, DIRECTORY, directoryEntry, type Area } from '@/lib/directory';
import type { SiteSettingsDTO } from '@/lib/site-export';
import { cn } from '@/lib/utils';
import { ConnectDrawer } from './connect-drawer';
import { ConnectOverview } from './connect-overview';

export interface HubProps {
  connectors: ConnectorViewDTO[];
  site: SiteSettingsDTO;
  /** What the platform's redirect brought back: the platform and a short result code. */
  initial: { connect: string | null; result: string | null };
}

const ACTION_LABEL = {
  connected: 'Manage',
  needs_key: 'Connect',
  needs_reconnect: 'Reconnect',
  set_up: 'Set up',
  manual: 'How to post',
  planned: 'Details',
} as const;

function Row({ view, onOpen }: { view: ConnectorViewDTO; onOpen(id: string): void }) {
  const entry = directoryEntry(view.id);
  const def = connectorFor(view.id);
  if (!entry || !def) return null;
  const area = AREA_STYLE[entry.area];
  const Icon = area.icon;
  const primary = view.state === 'needs_key' || view.state === 'needs_reconnect';
  return (
    <li id={entry.id} className="scroll-mt-24 rounded-xl border bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <button type="button" onClick={() => onOpen(view.id)} className="flex min-w-0 flex-1 basis-56 items-center gap-3 rounded-lg text-left" aria-label={`${ACTION_LABEL[view.state]}: ${entry.name}`}>
          <span aria-hidden className={cn('grid size-9 shrink-0 place-items-center rounded-lg bg-muted', area.text)}>
            <Icon className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-base leading-6 font-semibold">{entry.name}</span>
            <span className="block text-xs leading-5 text-muted-foreground">
              {AUTH_KIND_LABELS[def.kind]}
              {view.connection?.who ? ` · ${view.connection.who}` : ''}
            </span>
            <span className="block text-xs leading-5 text-muted-foreground">{view.detail}</span>
          </span>
        </button>
        <StatusChip chip={connectorChip(view.state)} />
        <Button type="button" variant={primary ? 'default' : 'outline'} size="default" onClick={() => onOpen(view.id)} aria-label={`${ACTION_LABEL[view.state]} ${entry.name}`}>
          {ACTION_LABEL[view.state]}
        </Button>
      </div>
    </li>
  );
}

/**
 * Every platform, grouped by area, each with a persistent health state and a button that opens the Connect drawer:
 * steps, the exact access asked for, secure fields, a Test button and a clear result. The overview above the list says
 * what is connected, what is ready, what only the owner can do and what is manual.
 */
export function IntegrationsHub({ connectors, site, initial }: HubProps) {
  const router = useRouter();
  const [views, setViews] = useState<Record<string, ConnectorViewDTO>>(() => Object.fromEntries(connectors.map((c) => [c.id, c])));
  const [openId, setOpenId] = useState<string | null>(initial.connect && connectorFor(initial.connect) ? initial.connect : null);
  const [result, setResult] = useState<string | null>(initial.result);
  const [queue, setQueue] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [area, setArea] = useState<Area | 'all'>('all');
  const { prefs, update } = useViewPrefs();

  // The platform's redirect brought a result code in the address. Keep the drawer open and clear the address.
  useEffect(() => {
    if (initial.connect || initial.result) router.replace('/platforms/integrations', { scroll: false });
  }, [initial.connect, initial.result, router]);

  const visible = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return DIRECTORY.filter((e) => words.every((w) => `${e.name} ${e.id} ${e.summary}`.toLowerCase().includes(w)));
  }, [query]);

  const categories: CategoryOption[] = [{ id: 'all', label: 'All categories', count: visible.length }, ...AREAS.map((a) => ({ id: a, label: AREA_LABELS[a], count: visible.filter((e) => e.area === a).length }))];

  const ordered = useMemo(() => DIRECTORY.map((e) => views[e.id]).filter((v): v is ConnectorViewDTO => Boolean(v)), [views]);

  const open = useCallback((id: string) => {
    setResult(null);
    setOpenId(id);
  }, []);

  const connectReady = useCallback(() => {
    const ready = ordered.filter((v) => overviewGroup(v.state) === 'ready').map((v) => v.id);
    setQueue(ready);
    const first = ready[0];
    if (first) open(first);
  }, [ordered, open]);

  const onView = useCallback((view: ConnectorViewDTO) => setViews((m) => ({ ...m, [view.id]: view })), []);

  const next = useMemo(() => {
    if (!openId) return null;
    const after = queue.slice(queue.indexOf(openId) + 1).find((id) => views[id] && overviewGroup(views[id].state) === 'ready' && id !== openId);
    const def = after ? connectorFor(after) : null;
    return after && def ? { id: after, name: def.name } : null;
  }, [openId, queue, views]);

  const current = openId ? (views[openId] ?? null) : null;

  return (
    <div className="grid gap-6">
      <section aria-labelledby="trust-heading" className="rounded-xl border bg-surface p-4 sm:p-5">
        <h2 id="trust-heading" className="text-base font-semibold">
          Your keys stay here
        </h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          A key or sign-in is checked with one read-only request, encrypted on this server and never shown again, not even to you. It is never sent to Claude Code, the agent API or any log, and only you, signed in here, can connect, test or disconnect anything. Connecting an account publishes nothing: every public post still needs your approval, one at a time.
        </p>
      </section>

      <ConnectOverview views={ordered} onOpen={open} onConnectReady={connectReady} />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-96">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search platforms" aria-label="Search integrations" className="pl-9" />
        </div>
      </div>

      <div className={cn('grid items-start gap-4 lg:gap-6', prefs.filtersCollapsed ? 'lg:grid-cols-[3rem_minmax(0,1fr)]' : 'lg:grid-cols-[13.5rem_minmax(0,1fr)]')}>
        <CategoryColumn options={categories} value={area} onChange={(id) => setArea(id as Area | 'all')} collapsed={prefs.filtersCollapsed} onCollapsedChange={(c) => update({ filtersCollapsed: c })} />
        <div className="min-w-0">
          {AREAS.map((a) => {
            const entries = visible.filter((e) => e.area === a && (area === 'all' || area === a));
            if (entries.length === 0) return null;
            return (
              <section key={a} aria-labelledby={`int-${a}`} className="mb-6 last:mb-0">
                <h2 id={`int-${a}`} className="text-lg font-semibold">
                  {AREA_LABELS[a]}
                </h2>
                <p className="mt-0.5 mb-3 text-sm text-muted-foreground">{AREA_BLURBS[a]}</p>
                <ul className="grid gap-2.5">
                  {entries.map((entry) => {
                    const view = views[entry.id];
                    return view ? <Row key={entry.id} view={view} onOpen={open} /> : null;
                  })}
                </ul>
              </section>
            );
          })}
          {visible.length === 0 ? <p className="rounded-xl border p-8 text-center text-sm text-muted-foreground">No platform matches that search.</p> : null}
        </div>
      </div>

      <ConnectDrawer id={openId} view={current} site={site} result={result} onClose={() => setOpenId(null)} onView={onView} onOpen={open} next={next} />
    </div>
  );
}

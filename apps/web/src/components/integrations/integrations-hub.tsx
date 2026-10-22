'use client';

import { ChevronDown, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AREA_STYLE } from '@/components/platforms/area-style';
import { Input } from '@/components/ui/field';
import { StatusChip } from '@/components/ui/status-chip';
import { directoryChip, type Chip } from '@/lib/chips';
import { AREAS, AREA_BLURBS, AREA_LABELS, DIRECTORY, METHOD_LABELS, directoryStatus, type DirectoryEntry } from '@/lib/directory';
import type { ConnectionDTO } from '@/lib/publishing';
import type { SiteSettingsDTO } from '@/lib/site-export';
import { cn } from '@/lib/utils';
import type { IntegrationDTO, SavedCredentialDTO } from '@/server/actions/integrations';
import { LiveConnection, type ConnectionView } from './live-connection';
import { AssistedSetup, KeySetup, ManualNote, OAuthSetup } from './setup-cards';
import { SiteSetup } from './site-setup';

export interface HubProps {
  connections: ConnectionView[];
  saved: IntegrationDTO[];
  site: SiteSettingsDTO;
  appUrl: string;
}

function chipFor(entry: DirectoryEntry, connection: ConnectionDTO | null, saved: SavedCredentialDTO[]): Chip {
  const connected = connection?.status === 'connected';
  const base = directoryChip(directoryStatus(entry, connected), entry.roadmap);
  if (!entry.adapter && saved.length > 0) return { label: 'Saved, not used yet', tone: 'info', icon: 'lock' };
  if (entry.adapter && connection && !connected) return { label: 'Needs reconnecting', tone: 'warning', icon: 'plug' };
  return base;
}

function Entry({
  entry,
  connection,
  saved,
  site,
  appUrl,
  viewOf,
  onConnection,
  onSaved,
  defaultOpen,
}: {
  entry: DirectoryEntry;
  connection: ConnectionDTO | null;
  saved: SavedCredentialDTO[];
  site: SiteSettingsDTO;
  appUrl: string;
  viewOf: ConnectionView | undefined;
  onConnection(connection: ConnectionDTO | null): void;
  onSaved(saved: SavedCredentialDTO[]): void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const area = AREA_STYLE[entry.area];
  const Icon = area.icon;
  const chip = chipFor(entry, connection, saved);

  useEffect(() => {
    const check = () => {
      if (window.location.hash === `#${entry.id}`) {
        setOpen(true);
        document.getElementById(entry.id)?.scrollIntoView({ block: 'start' });
      }
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [entry.id]);

  let body: React.ReactNode;
  if (entry.id === 'site' && viewOf) body = <SiteSetup initial={site} view={{ ...viewOf, connection }} onConnection={onConnection} />;
  else if (entry.adapter && viewOf) body = <LiveConnection view={{ ...viewOf, connection }} onChange={onConnection} />;
  else if (entry.method === 'oauth') body = <OAuthSetup entry={entry} saved={saved} onSaved={onSaved} appUrl={appUrl} />;
  else if (entry.method === 'browser_assisted') body = <AssistedSetup entry={entry} saved={saved} onSaved={onSaved} appUrl={appUrl} />;
  else if (entry.method === 'api_key') body = <KeySetup entry={entry} saved={saved} onSaved={onSaved} />;
  else body = <ManualNote entry={entry} />;

  return (
    <li id={entry.id} className="scroll-mt-24 rounded-xl border bg-surface">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`setup-${entry.id}`}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-4 py-3 text-left transition-colors duration-[120ms] hover:bg-muted/50"
        >
          <span aria-hidden className={cn('grid size-8 shrink-0 place-items-center rounded-lg bg-muted', area.text)}>
            <Icon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base leading-6 font-semibold">{entry.name}</span>
            <span className="block text-xs text-muted-foreground">
              {METHOD_LABELS[entry.method]} · {entry.directoryOnly ? 'Directory only' : entry.adapter ? 'Works today' : entry.roadmap ?? (entry.method === 'manual_only' ? 'You post it' : 'Planned')}
            </span>
          </span>
          <StatusChip chip={chip} />
          <ChevronDown aria-hidden className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </button>
      </h3>
      {open ? (
        <div id={`setup-${entry.id}`} className="border-t p-4 sm:p-5">
          <p className="mb-4 text-sm leading-6 text-muted-foreground">{entry.summary}</p>
          {body}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Every platform, grouped by area, each with a setup card that matches how it connects: a key (guided, and
 * working today for DEV.to, Hashnode and GitHub), an OAuth app (details saved now, connect later), assisted setup
 * (steps and a prompt for your own Claude), or nothing at all. Everything shows up, including what is disabled.
 */
export function IntegrationsHub({ connections, saved, site, appUrl }: HubProps) {
  const [conns, setConns] = useState<Record<string, ConnectionDTO | null>>(() => Object.fromEntries(connections.map((c) => [c.platform, c.connection])));
  const [stored, setStored] = useState<Record<string, SavedCredentialDTO[]>>(() => Object.fromEntries(saved.map((s) => [s.platform, s.saved])));
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return DIRECTORY.filter((e) => words.every((w) => `${e.name} ${e.id} ${e.summary}`.toLowerCase().includes(w)));
  }, [query]);

  return (
    <div className="grid gap-6">
      <section aria-labelledby="trust-heading" className="rounded-xl border bg-surface p-4 sm:p-5">
        <h2 id="trust-heading" className="text-base font-semibold">
          Your keys stay here
        </h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          A key is checked with a read-only call, encrypted on this server and never shown again, not even to you. It is never sent to Claude Code, the agent API or any log. Connecting an account publishes nothing: every public post still needs your approval, one at a time. Values saved for platforms that are not built yet are encrypted too, labelled “Saved. Not used yet.”, and wiped when you remove them.
        </p>
      </section>

      <div className="relative sm:w-96">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search platforms" aria-label="Search integrations" className="pl-9" />
      </div>

      {AREAS.map((a) => {
        const entries = visible.filter((e) => e.area === a);
        if (entries.length === 0) return null;
        return (
          <section key={a} aria-labelledby={`int-${a}`}>
            <h2 id={`int-${a}`} className="text-lg font-semibold">
              {AREA_LABELS[a]}
            </h2>
            <p className="mt-0.5 mb-3 text-sm text-muted-foreground">{AREA_BLURBS[a]}</p>
            <ul className="grid gap-3">
              {entries.map((entry) => (
                <Entry
                  key={entry.id}
                  entry={entry}
                  connection={conns[entry.id] ?? null}
                  saved={stored[entry.id] ?? []}
                  site={site}
                  appUrl={appUrl}
                  viewOf={connections.find((c) => c.platform === entry.id)}
                  onConnection={(c) => setConns((m) => ({ ...m, [entry.id]: c }))}
                  onSaved={(s) => setStored((m) => ({ ...m, [entry.id]: s }))}
                  defaultOpen={false}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {visible.length === 0 ? <p className="rounded-xl border p-8 text-center text-sm text-muted-foreground">No platform matches that search.</p> : null}
    </div>
  );
}

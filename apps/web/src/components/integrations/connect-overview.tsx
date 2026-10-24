'use client';

import { CircleCheck, KeyRound, PenLine, Plug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { connectorFor } from '@/lib/connectors';
import type { ConnectorViewDTO } from '@/lib/connectors/dto';
import { overviewGroup, type OverviewGroup } from '@/lib/connectors/state';

const nameOf = (id: string) => connectorFor(id)?.name ?? id;

function Tile({ icon: Icon, title, count, children }: { icon: typeof Plug; title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="grid content-start gap-2 rounded-xl border bg-surface p-4" aria-label={title}>
      <div className="flex items-center gap-2">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="mono-label ml-auto text-muted-foreground">{count}</span>
      </div>
      {children}
    </section>
  );
}

function Names({ views, onOpen, empty }: { views: ConnectorViewDTO[]; onOpen(id: string): void; empty: string }) {
  if (views.length === 0) return <p className="text-xs leading-5 text-muted-foreground">{empty}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {views.slice(0, 12).map((v) => (
        <li key={v.id}>
          <button type="button" onClick={() => onOpen(v.id)} className="inline-flex min-h-10 items-center rounded-md border bg-background px-2.5 text-sm transition-colors duration-[120ms] hover:bg-accent hover:text-accent-foreground">
            {nameOf(v.id)}
          </button>
        </li>
      ))}
      {views.length > 12 ? <li className="self-center text-xs text-muted-foreground">and {views.length - 12} more in the list</li> : null}
    </ul>
  );
}

/**
 * The overview at the top of Integrations: what is connected, what is ready for you to connect in a few clicks, what
 * only you can do (register your own app) and what is manual. "Connect all that are ready" walks the ready ones one
 * after another; each still needs your own key or sign-in, because nothing here can connect for you.
 */
export function ConnectOverview({ views, onOpen, onConnectReady }: { views: ConnectorViewDTO[]; onOpen(id: string): void; onConnectReady(): void }) {
  const by: Record<OverviewGroup, ConnectorViewDTO[]> = { connected: [], ready: [], owner: [], manual: [] };
  for (const v of views) by[overviewGroup(v.state)].push(v);
  const reconnect = by.ready.filter((v) => v.state === 'needs_reconnect');

  return (
    <section aria-labelledby="overview-heading" className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="overview-heading" className="text-lg font-semibold">
          Your connections
        </h2>
        <Button type="button" className="w-full sm:ml-auto sm:w-auto" disabled={by.ready.length === 0} onClick={onConnectReady}>
          <Plug aria-hidden />
          Connect all that are ready{by.ready.length > 0 ? ` (${by.ready.length})` : ''}
        </Button>
      </div>
      {reconnect.length > 0 ? (
        <p className="rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2 text-sm text-foreground">
          {reconnect.length === 1 ? `${nameOf(reconnect[0]!.id)} needs reconnecting.` : `${reconnect.map((v) => nameOf(v.id)).join(', ')} need reconnecting.`}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={CircleCheck} title="Connected" count={by.connected.length}>
          <Names views={by.connected} onOpen={onOpen} empty="Nothing is connected yet." />
        </Tile>
        <Tile icon={KeyRound} title="Ready for your key or sign-in" count={by.ready.length}>
          <Names views={by.ready} onOpen={onOpen} empty="Everything that can be connected is." />
        </Tile>
        <Tile icon={PenLine} title="Set up needed" count={by.owner.length}>
          <p className="text-xs leading-5 text-muted-foreground">Register your own app on the platform, or the platform could not be confirmed yet.</p>
          <Names views={by.owner} onOpen={onOpen} empty="Nothing waits on a registration." />
        </Tile>
        <Tile icon={Plug} title="Manual: you post it" count={by.manual.length}>
          <p className="text-xs leading-5 text-muted-foreground">No API or no self-serve access. The app prepares the post and you publish it yourself. Open any of them for the reason.</p>
        </Tile>
      </div>
    </section>
  );
}

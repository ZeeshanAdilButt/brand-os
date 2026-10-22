'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { chipDescription, chipText, modeLabel, type ChipState } from '@/lib/status';
import type { Health } from '@/server/actions/system';

type State = { kind: 'loading' } | { kind: 'unreachable' } | { kind: 'loaded'; health: Health };

const REFRESH_MS = 30_000;

const DOT: Record<ChipState, string> = {
  loading: 'bg-muted-foreground/60 motion-safe:animate-pulse',
  ok: 'bg-success',
  degraded: 'bg-warning',
  error: 'bg-destructive',
};

/** Live mode and database status from GET /api/health. Links to Settings for the detail. */
export function StatusChip({ endpoint = '/api/health' }: { endpoint?: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const res = await fetch(endpoint, { cache: 'no-store' });
        const health = (await res.json()) as Health;
        if (!cancelled) setState({ kind: 'loaded', health });
      } catch {
        if (!cancelled) setState({ kind: 'unreachable' });
      }
    }
    void refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [endpoint]);

  let chip: ChipState = 'loading';
  let text = 'Checking';
  let description = 'Checking system status.';
  let mode = '';
  if (state.kind === 'unreachable') {
    chip = 'error';
    text = 'App unreachable';
    description = 'The app server did not answer the health check.';
  } else if (state.kind === 'loaded') {
    chip = state.health.status;
    text = chipText(state.health);
    description = chipDescription(state.health);
    mode = modeLabel(state.health.mode);
  }

  return (
    <Link
      href="/settings"
      title={description}
      aria-label={`System status: ${description} Open settings.`}
      data-state={chip}
      className="inline-flex h-8 max-w-full items-center gap-2 rounded-full border bg-surface px-2.5 text-xs font-medium text-foreground transition-colors duration-[120ms] hover:bg-muted"
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT[chip])} />
      <span className="hidden truncate sm:inline">{text}</span>
      <span className="truncate sm:hidden">{chip === 'ok' && mode ? mode : chip === 'loading' ? 'Checking' : chip === 'degraded' ? 'Migrate' : 'Offline'}</span>
    </Link>
  );
}

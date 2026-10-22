// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusChip } from '../src/components/shell/status-chip';
import type { Health } from '../src/server/actions/system';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubHealth(health: Health | Error) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (health instanceof Error) throw health;
      return new Response(JSON.stringify(health), { status: health.status === 'error' ? 503 : 200 });
    }),
  );
}

describe('StatusChip', () => {
  it('shows only the mode in the bar, keeps the engine and latency in the tooltip, and links to settings', async () => {
    stubHealth({ status: 'ok', mode: 'local', db: { ok: true, driver: 'pglite', latencyMs: 1.4, schema: 'ready' } });
    render(<StatusChip />);
    const link = await screen.findByRole('link', { name: /System status/ });
    await waitFor(() => expect(link.getAttribute('data-state')).toBe('ok'));
    expect(link.textContent).toContain('Local');
    expect(link.textContent).not.toContain('PGlite');
    expect(link.textContent).not.toContain('ms');
    expect(link.getAttribute('aria-label')).toContain('PGlite');
    expect(link.getAttribute('aria-label')).toContain('1.4 ms');
    expect(link.getAttribute('href')).toBe('/settings');
  });

  it('says so when migrations are pending', async () => {
    stubHealth({ status: 'degraded', mode: 'hosted', db: { ok: true, driver: 'postgres', latencyMs: 8, schema: 'pending' } });
    render(<StatusChip />);
    await waitFor(() => expect(screen.getByRole('link').getAttribute('data-state')).toBe('degraded'));
    expect(screen.getByRole('link').getAttribute('aria-label')).toContain('pnpm db:migrate');
  });

  it('shows an error state when the database is down', async () => {
    stubHealth({ status: 'error', mode: 'local', db: { ok: false, driver: 'pglite', latencyMs: null, schema: 'unknown', error: 'database did not answer' } });
    render(<StatusChip />);
    await waitFor(() => expect(screen.getByRole('link').getAttribute('data-state')).toBe('error'));
    expect(screen.getByRole('link').textContent).toContain('Database offline');
  });

  it('shows an error state when the app itself is unreachable', async () => {
    stubHealth(new TypeError('Failed to fetch'));
    render(<StatusChip />);
    await waitFor(() => expect(screen.getByRole('link').getAttribute('data-state')).toBe('error'));
    expect(screen.getByRole('link').textContent).toContain('App unreachable');
  });
});

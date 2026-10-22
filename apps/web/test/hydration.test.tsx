// @vitest-environment jsdom
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JourneySteps } from '../src/components/guided/journey-steps';
import { PlatformDirectory, type DirectoryItem } from '../src/components/platforms/platform-directory';
import { ArticlePicker } from '../src/components/publish/workspace/article-picker';
import { PlatformSelector } from '../src/components/publish/workspace/platform-selector';
import { StatusChip } from '../src/components/ui/status-chip';
import { directoryChip } from '../src/lib/chips';
import { DIRECTORY, directoryStatus } from '../src/lib/directory';
import { computeJourney } from '../src/lib/next-step';
import { selectorRows } from '../src/lib/publish-workspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  vi.restoreAllMocks();
});

/** Render on the server, then hydrate that markup in a browser-like document. Any mismatch or warning is a failure. */
async function hydrates(element: ReactElement): Promise<string[]> {
  const html = renderToString(element);
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.append(container);
  mounted.push(container);
  const problems: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    problems.push(args.map(String).join(' ').slice(0, 200));
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
    problems.push(args.map(String).join(' ').slice(0, 200));
  });
  await act(async () => {
    hydrateRoot(container, element, {
      onRecoverableError: (error) => problems.push(`recoverable: ${String(error).slice(0, 200)}`),
    });
  });
  spy.mockRestore();
  warn.mockRestore();
  return problems;
}

const ARTICLES = [
  { id: 'a1', title: 'Why the write path stalls', status: 'draft' as const, words: 1200, updatedAt: '2026-10-21T10:00:00.000Z' },
  { id: 'a2', title: 'A short note on retries', status: 'ready' as const, words: 300, updatedAt: '2026-10-22T10:00:00.000Z' },
];

describe('server markup matches what the browser renders', () => {
  it('every status chip, for every directory entry in every state', async () => {
    const chips = DIRECTORY.flatMap((entry) => [false, true].map((connected) => directoryChip(directoryStatus(entry, connected), entry.roadmap)));
    const problems = await hydrates(
      <div>
        {chips.map((chip, i) => (
          <StatusChip key={i} chip={chip} />
        ))}
      </div>,
    );
    expect(problems).toEqual([]);
  });

  it('the platform directory', async () => {
    const items: DirectoryItem[] = DIRECTORY.map((entry) => ({ entry, status: directoryStatus(entry, false), who: null }));
    expect(await hydrates(<PlatformDirectory items={items} />)).toEqual([]);
  });

  it('the platform selector and the article picker', async () => {
    const rows = selectorRows(new Set());
    expect(await hydrates(<PlatformSelector rows={rows} selected={new Set()} busy={new Set()} onToggle={() => undefined} recommendations={[{ platform: 'site', reason: 'First.' }]} />)).toEqual([]);
    expect(await hydrates(<ArticlePicker articles={ARTICLES} selectedId="a1" onSelect={() => undefined} />)).toEqual([]);
  });

  it('the progress steps on Home', async () => {
    const journey = computeJourney({ articleCount: 1, article: { id: 'a1', title: 'T', hasText: true }, destinations: [] });
    expect(await hydrates(<JourneySteps steps={journey.steps} />)).toEqual([]);
  });
});

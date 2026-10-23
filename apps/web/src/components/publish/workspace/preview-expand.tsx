'use client';

import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { PlatformPreview, type PreviewInput } from '@/components/publishing/previews/platform-preview';
import { PreviewExpandContext, PreviewScaleContext, PreviewViewContext, type ExpandApi } from '@/components/publishing/previews/preview-context';
import type { Device } from '@/components/publishing/previews/preview-frame';
import { Button } from '@/components/ui/button';
import type { PlatformId } from '@/lib/catalog';
import { OVERLAY_SCALE } from '@/lib/preview-layout';
import type { LintIssue } from '@/lib/publishing';
import { isTypingTarget, wrapIndex } from '@/lib/shortcuts';
import { ChecksRow } from '../shared';

const NARROW = '(max-width: 639px)';
function watchNarrow(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(NARROW);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
const isNarrow = () => typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches;

/** One platform that can be opened large: what to draw and what its checks said. */
export interface ExpandEntry {
  platform: PlatformId;
  name: string;
  input: PreviewInput;
  lint: LintIssue[];
}

/**
 * Gives every preview below it an Expand control. Expanding opens one platform's preview over the whole screen, with
 * its checks, the device switch and previous/next controls (and the arrow keys) that go round the platforms you chose.
 * The overlay reads the same live entries as the page, so an edit shows up in it at once.
 */
export function PreviewExpandProvider({ entries, children }: { entries: ExpandEntry[]; children: ReactNode }) {
  const [current, setCurrent] = useState<PlatformId | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const api = useMemo<ExpandApi>(
    () => ({
      open(platform, button) {
        opener.current = button;
        setCurrent(platform);
      },
    }),
    [],
  );
  return (
    <PreviewExpandContext.Provider value={api}>
      {children}
      <ExpandedPreview entries={entries} current={current} onChange={setCurrent} opener={opener} />
    </PreviewExpandContext.Provider>
  );
}

/** The overlay itself. Controlled: `current` is the platform shown, or null when closed. */
export function ExpandedPreview({
  entries,
  current,
  onChange,
  opener,
}: {
  entries: ExpandEntry[];
  current: PlatformId | null;
  onChange(platform: PlatformId | null): void;
  opener?: { current: HTMLElement | null };
}) {
  const [device, setDevice] = useState<Device>('desktop');
  // On a phone the preview is already as wide as the screen, so it is not scaled up further.
  const narrow = useSyncExternalStore(watchNarrow, isNarrow, () => false);
  const index = current ? entries.findIndex((e) => e.platform === current) : -1;
  const entry = index >= 0 ? entries[index]! : null;
  const count = entries.length;

  function move(delta: number) {
    if (index < 0 || count < 2) return;
    onChange(entries[wrapIndex(index, delta, count)]!.platform);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isTypingTarget(event.target)) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      move(1);
    }
  }

  const previous = count > 1 && index >= 0 ? entries[wrapIndex(index, -1, count)]! : null;
  const next = count > 1 && index >= 0 ? entries[wrapIndex(index, 1, count)]! : null;

  return (
    <DialogPrimitive.Root open={entry !== null} onOpenChange={(open) => (open ? undefined : onChange(null))}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none" />
        <DialogPrimitive.Content
          onKeyDown={onKeyDown}
          onCloseAutoFocus={(event) => {
            const button = opener?.current;
            if (button?.isConnected) {
              event.preventDefault();
              button.focus();
            }
          }}
          aria-describedby="expanded-preview-hint"
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background outline-none sm:inset-3 sm:rounded-2xl sm:border-[1.5px] sm:border-border-strong sm:shadow-window"
        >
          <header data-surface="forest" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 bg-solid px-3 py-2.5 text-solid-foreground sm:px-5">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="truncate font-sans text-base font-semibold tracking-normal text-solid-foreground">{entry ? `${entry.name} preview` : 'Preview'}</DialogPrimitive.Title>
              <DialogPrimitive.Description id="expanded-preview-hint" className="text-xs text-solid-muted">
                {entry && count > 1 ? `Preview ${index + 1} of ${count}. Left and right arrow keys move between platforms. Esc closes.` : 'Esc closes.'}
              </DialogPrimitive.Description>
            </div>
            {previous && next ? (
              <div className="flex items-center gap-1" role="group" aria-label="Move between platforms">
                <Button type="button" variant="outline" size="sm" className="border-solid-muted/60 bg-transparent text-solid-foreground hover:bg-white/15 hover:text-solid-foreground" onClick={() => move(-1)} aria-label={`Previous platform: ${previous.name}`}>
                  <ChevronLeft aria-hidden />
                  <span className="hidden sm:inline">{previous.name}</span>
                </Button>
                <Button type="button" variant="outline" size="sm" className="border-solid-muted/60 bg-transparent text-solid-foreground hover:bg-white/15 hover:text-solid-foreground" onClick={() => move(1)} aria-label={`Next platform: ${next.name}`}>
                  <span className="hidden sm:inline">{next.name}</span>
                  <ChevronRight aria-hidden />
                </Button>
              </div>
            ) : null}
            <DialogPrimitive.Close asChild>
              <Button type="button" variant="ghost" size="icon-sm" className="text-solid-foreground hover:bg-white/15 hover:text-solid-foreground" aria-label="Close expanded preview">
                <X aria-hidden />
              </Button>
            </DialogPrimitive.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-5">
            {entry ? (
              <div className="mx-auto grid max-w-[min(100%,80rem)] gap-4">
                <ChecksRow issues={entry.lint} empty="No problems found for this platform." defaultOpen />
                <PreviewExpandContext.Provider value={null}>
                  <PreviewViewContext.Provider value={null}>
                    <PreviewScaleContext.Provider value={narrow ? 1 : OVERLAY_SCALE}>
                      <PlatformPreview key={entry.platform} input={entry.input} defaultDevice={device} onDeviceChange={setDevice} />
                    </PreviewScaleContext.Provider>
                  </PreviewViewContext.Provider>
                </PreviewExpandContext.Provider>
              </div>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

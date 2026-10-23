'use client';

import { GripVertical, Maximize2, Minus, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const STEP = 24;
const MARGIN = 8;
/** The top bar of the page is 64px tall: the window never goes under it. */
const TOP_LIMIT = 72;

/**
 * An optional floating preview window. A forest title bar is the handle: drag it, or focus the grip and use the arrow
 * keys, to move the window; it can be minimised to its bar, expanded to the large overlay, or closed (which puts the
 * preview back in the page). The window never leaves the screen and never covers the top bar. It is positioned with a
 * transform from its resting place, so it costs no layout and survives a resize.
 */
export function PreviewWindow({
  title,
  minimized,
  onToggleMinimized,
  onExpand,
  onClose,
  expandLabel,
  children,
  className,
}: {
  title: string;
  minimized: boolean;
  onToggleMinimized(): void;
  /** Receives the button so focus can come back to it when the overlay closes. */
  onExpand(button: HTMLButtonElement): void;
  onClose(): void;
  expandLabel: string;
  children: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ startX: number; startY: number; from: { x: number; y: number } } | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Keep the window on screen: its bar fully inside the viewport, below the top bar. */
  const clamp = useCallback((next: { x: number; y: number }, from: { x: number; y: number }) => {
    const el = ref.current;
    if (!el) return next;
    const rect = el.getBoundingClientRect();
    const baseLeft = rect.left - from.x;
    const baseTop = rect.top - from.y;
    const x = Math.min(Math.max(next.x, MARGIN - baseLeft), window.innerWidth - rect.width - MARGIN - baseLeft);
    const y = Math.min(Math.max(next.y, TOP_LIMIT - baseTop), window.innerHeight - 56 - baseTop);
    return { x, y };
  }, []);

  useEffect(() => {
    const onResize = () => setOffset((o) => clamp(o, o));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    // The buttons in the bar are for clicking, not for starting a drag.
    if ((event.target as HTMLElement).closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startY: event.clientY, from: offset };
    setDragging(true);
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    setOffset(clamp({ x: d.from.x + event.clientX - d.startX, y: d.from.y + event.clientY - d.startY }, offset));
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function onGripKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const move = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[event.key];
    if (!move) return;
    event.preventDefault();
    setOffset((o) => clamp({ x: o.x + (move[0] as number), y: o.y + (move[1] as number) }, o));
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    // Escape inside the window puts the preview back in the page, unless something inside it already used the key.
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.stopPropagation();
      onClose();
    }
  }

  const barButton = 'grid size-9 shrink-0 place-items-center rounded-lg text-solid-foreground transition-colors duration-[120ms] hover:bg-white/15';
  return (
    <section
      ref={ref}
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      className={cn(
        'fixed top-32 right-8 z-30 flex w-[min(32.5rem,calc(100vw-4rem))] flex-col overflow-hidden rounded-2xl border-[1.5px] border-border-strong bg-surface shadow-window',
        dragging && 'select-none',
        className,
      )}
    >
      <div
        data-surface="forest"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={cn('flex h-12 shrink-0 touch-none items-center gap-1 bg-solid pr-2 pl-2 text-solid-foreground', dragging ? 'cursor-grabbing' : 'cursor-grab')}
      >
        <button
          type="button"
          onKeyDown={onGripKeyDown}
          aria-label="Move preview window. Use the arrow keys."
          title="Drag the bar to move, or use the arrow keys here"
          className="grid size-9 shrink-0 cursor-grab place-items-center rounded-lg text-solid-muted hover:bg-white/15"
        >
          <GripVertical aria-hidden className="size-4" />
        </button>
        <h2 id={titleId} className="min-w-0 flex-1 truncate font-sans text-[0.9375rem] font-semibold tracking-normal text-solid-foreground">
          {title}
        </h2>
        <button type="button" onClick={onToggleMinimized} aria-expanded={!minimized} aria-label={minimized ? 'Restore preview window' : 'Minimize preview window'} title={minimized ? 'Restore' : 'Minimize'} className={barButton}>
          {minimized ? <Plus aria-hidden className="size-4" /> : <Minus aria-hidden className="size-4" />}
        </button>
        <button type="button" onClick={(e) => onExpand(e.currentTarget)} aria-haspopup="dialog" aria-label={expandLabel} title="Open large" className={barButton}>
          <Maximize2 aria-hidden className="size-4" />
        </button>
        <button type="button" onClick={onClose} aria-label="Close preview window and put the preview back in the page" title="Close (the preview goes back in the page)" className={barButton}>
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <div hidden={minimized} className="max-h-[calc(100dvh-14rem)] min-h-0 overflow-y-auto overscroll-contain p-4">
        {children}
      </div>
    </section>
  );
}

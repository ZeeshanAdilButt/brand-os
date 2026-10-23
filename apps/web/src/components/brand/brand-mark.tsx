import { cn } from '@/lib/utils';

/**
 * The Brand OS mark: one source node that branches three ways. A tile in forest with lime lines, or the reverse for
 * use on forest. The strokes thicken at 24px and below so the branches survive a small size, as in the identity sheet.
 *
 *   tile    forest tile, lime lines (the default)
 *   inverse lime tile, forest lines (on a forest surface)
 *   plain   no tile, the current text colour (one colour only)
 */
export type BrandMarkTone = 'tile' | 'inverse' | 'plain';

interface Metrics {
  stroke: number;
  source: number;
  node: number;
  radius: number;
}

/** Line weights for the 64 unit drawing, chosen by the size it is drawn at. */
export function markMetrics(size: number): Metrics {
  if (size <= 16) return { stroke: 7, source: 8, node: 6, radius: 14 };
  if (size <= 24) return { stroke: 6, source: 7.5, node: 5.5, radius: 15 };
  if (size <= 32) return { stroke: 5.5, source: 7, node: 5, radius: 16 };
  return { stroke: 4.5, source: 6.5, node: 4.5, radius: 16 };
}

export function BrandMark({ size = 32, tone = 'tile', title, className }: { size?: number; tone?: BrandMarkTone; title?: string; className?: string }) {
  const m = markMetrics(size);
  const tile = tone === 'tile' ? 'var(--forest)' : tone === 'inverse' ? 'var(--lime)' : null;
  const ink = tone === 'tile' ? 'var(--lime)' : tone === 'inverse' ? 'var(--forest)' : 'currentColor';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className={cn('shrink-0', className)}
    >
      {tile ? <rect width="64" height="64" rx={m.radius} fill={tile} /> : null}
      <g fill="none" stroke={ink} strokeWidth={m.stroke} strokeLinecap="round">
        <path d="M17 32C30 32 32 16 46 16" />
        <path d="M17 32H46" />
        <path d="M17 32C30 32 32 48 46 48" />
      </g>
      <circle cx="17" cy="32" r={m.source} fill={ink} />
      <g fill={ink}>
        <circle cx="48" cy="16" r={m.node} />
        <circle cx="48" cy="32" r={m.node} />
        <circle cx="48" cy="48" r={m.node} />
      </g>
    </svg>
  );
}

/** The mark with "Brand OS" beside it, set in the display font. `onForest` swaps the colours for a forest surface. */
export function BrandLockup({ size = 32, onForest = false, className }: { size?: number; onForest?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <BrandMark size={size} tone={onForest ? 'inverse' : 'tile'} />
      <span
        className={cn('font-display leading-none font-semibold tracking-[-0.02em]', onForest ? 'text-sidebar-foreground' : 'text-foreground')}
        style={{ fontSize: Math.round(size * 0.625) }}
      >
        Brand OS
      </span>
    </span>
  );
}

import type { PreviewLayout, PreviewSize } from './view-prefs';

/** How much the simulated surface is scaled for each size choice. The preview text scales with it. */
export const SIZE_SCALE: Record<PreviewSize, number> = { compact: 0.85, comfortable: 1, large: 1.25 };

/** The expanded overlay always shows a preview larger than the largest size in the page. */
export const OVERLAY_SCALE = 1.5;

export const LAYOUT_LABELS: Record<PreviewLayout, string> = {
  single: 'One large preview',
  grid2: '2 columns',
  grid3: '3 columns',
  compare: 'Side by side compare',
};

/** A comparison needs two prepared previews; with fewer, the layout falls back to one large preview. */
export function effectiveLayout(layout: PreviewLayout, preparedCount: number): PreviewLayout {
  return layout === 'compare' && preparedCount < 2 ? 'single' : layout;
}

/**
 * Columns for the grid layouts, by the width of the previews area (container queries, so a narrow area never gets
 * more columns than it can hold). Three columns fall back to two, then one.
 */
export function gridClass(layout: PreviewLayout): string {
  if (layout === 'grid2') return '@2xl:grid-cols-2';
  if (layout === 'grid3') return '@2xl:grid-cols-2 @5xl:grid-cols-3';
  return '';
}

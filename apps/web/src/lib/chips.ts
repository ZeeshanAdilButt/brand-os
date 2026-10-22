import type { DirectoryStatus } from './directory';
import { statusLabel, type DraftStatus, type PlatformId, type PublishedVia } from './publishing';

/**
 * One colour language for status, used on Home, Platforms, Integrations, the studio and the composer:
 * green is done and live, teal is checked or staged, amber is waiting on you or on the platform, red needs
 * attention, grey is idle, and dashed grey is not available. Colour never carries the meaning alone: every chip
 * has words.
 */
export type Tone = 'ok' | 'info' | 'wait' | 'bad' | 'muted' | 'off';

export const TONE_CLASS: Record<Tone, string> = {
  ok: 'border-success/60 bg-success/10 text-success',
  info: 'border-teal-text/50 bg-teal-text/5 text-teal-text',
  wait: 'border-warning/60 bg-warning/10 text-warning',
  bad: 'border-destructive/50 bg-destructive/10 text-destructive',
  muted: 'border-input text-muted-foreground',
  off: 'border-dashed border-input text-muted-foreground',
};

export interface Chip {
  label: string;
  tone: Tone;
}

/** The pills of a destination card: not prepared, draft, staged, pending approval, approved, publishing, published, failed, unknown, stale. */
export function draftChip(platform: PlatformId, draft: { status: DraftStatus; publishedVia: PublishedVia | null } | null): Chip {
  if (!draft) return { label: 'Not prepared', tone: 'muted' };
  const label = draft.status === 'source_changed' ? 'Stale' : statusLabel(platform, draft.status, draft.publishedVia);
  const tone: Record<DraftStatus, Tone> = {
    draft: 'muted',
    staged: 'info',
    pending_approval: 'wait',
    approved: 'wait',
    publishing: 'wait',
    published: 'ok',
    failed: 'bad',
    unknown: 'bad',
    source_changed: 'wait',
  };
  return { label, tone: tone[draft.status] };
}

export function directoryChip(status: DirectoryStatus, roadmap: string | null): Chip {
  switch (status) {
    case 'available_now':
      return { label: 'Available now', tone: 'ok' };
    case 'needs_connection':
      return { label: 'Needs connection', tone: 'wait' };
    case 'preview_only':
      return { label: 'Preview only', tone: 'info' };
    case 'manual_only':
      return { label: 'Manual only', tone: 'muted' };
    case 'planned':
      return { label: roadmap ? `Planned: ${roadmap.split(',')[0]}` : 'Planned', tone: 'off' };
  }
}

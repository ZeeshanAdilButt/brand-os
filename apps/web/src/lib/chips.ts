import { STATE_LABELS, type ConnectionState } from './connectors/types';
import type { DirectoryStatus } from './directory';
import { statusLabel, type DraftStatus, type PlatformId, type PublishedVia } from './publishing';

/**
 * One status language for Home, Platforms, Integrations, the studio and the composer. Attention, progress, success
 * and uncertainty each have their own colour AND their own icon and words, so nothing is told apart by colour alone:
 *
 *   attention needs setting up (a connection): the warm accent, the only place it marks state
 *   warning  needs you (pending approval) or is uncertain (unknown result, stale draft, needs connection)
 *   info     progress or a recorded step (private draft, approved, publishing, preview only)
 *   success  done and live
 *   danger   failed
 *   neutral  idle or informational (not prepared, draft, manual only)
 *   planned  not available yet: dashed outline
 */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'planned' | 'attention';

export type ChipIcon =
  | 'dashed-circle'
  | 'file'
  | 'lock'
  | 'review'
  | 'shield-check'
  | 'spinner'
  | 'check-circle'
  | 'alert-circle'
  | 'help-circle'
  | 'refresh'
  | 'plug'
  | 'plug-check'
  | 'eye'
  | 'external-link'
  | 'calendar';

export const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-border bg-neutral-subtle text-neutral',
  info: 'border-info/25 bg-info-subtle text-info',
  success: 'border-success/25 bg-success-subtle text-success',
  warning: 'border-warning/30 bg-warning-subtle text-warning',
  danger: 'border-danger/30 bg-danger-subtle text-danger',
  planned: 'border-dashed border-input bg-transparent text-neutral',
  attention: 'border-accent-warm/30 bg-accent-warm-soft text-accent-warm-ink',
};

export interface Chip {
  label: string;
  tone: Tone;
  icon: ChipIcon;
}

/** The pills of a destination card: not prepared, draft, private draft, pending approval, approved, publishing, published, failed, unknown, stale. */
export function draftChip(platform: PlatformId, draft: { status: DraftStatus; publishedVia: PublishedVia | null } | null): Chip {
  if (!draft) return { label: 'Not prepared', tone: 'neutral', icon: 'dashed-circle' };
  const base: Record<DraftStatus, { tone: Tone; icon: ChipIcon }> = {
    draft: { tone: 'neutral', icon: 'file' },
    staged: { tone: 'info', icon: 'lock' },
    pending_approval: { tone: 'warning', icon: 'review' },
    approved: { tone: 'info', icon: 'shield-check' },
    publishing: { tone: 'info', icon: 'spinner' },
    published: { tone: 'success', icon: 'check-circle' },
    failed: { tone: 'danger', icon: 'alert-circle' },
    unknown: { tone: 'warning', icon: 'help-circle' },
    source_changed: { tone: 'warning', icon: 'refresh' },
  };
  const label = draft.status === 'source_changed' ? 'Stale' : draft.status === 'staged' && platform !== 'site' ? 'Private draft' : statusLabel(platform, draft.status, draft.publishedVia);
  return { label, ...base[draft.status] };
}

export function directoryChip(status: DirectoryStatus, roadmap: string | null): Chip {
  switch (status) {
    case 'available_now':
      return { label: 'Available now', tone: 'success', icon: 'plug-check' };
    case 'needs_connection':
      return { label: 'Needs connection', tone: 'attention', icon: 'plug' };
    case 'preview_only':
      return { label: 'Preview only', tone: 'neutral', icon: 'eye' };
    case 'manual_only':
      return { label: 'Manual only', tone: 'neutral', icon: 'external-link' };
    case 'planned':
      return { label: roadmap && roadmap.startsWith('Phase') ? `Planned: ${roadmap.split(',')[0]}` : 'Planned', tone: 'planned', icon: 'calendar' };
  }
}

/** The pill for a connector: the state word the owner asked for, with its own icon and tone. */
export function connectorChip(state: ConnectionState): Chip {
  switch (state) {
    case 'connected':
      return { label: STATE_LABELS.connected, tone: 'success', icon: 'plug-check' };
    case 'needs_key':
      return { label: STATE_LABELS.needs_key, tone: 'attention', icon: 'plug' };
    case 'needs_reconnect':
      return { label: STATE_LABELS.needs_reconnect, tone: 'warning', icon: 'refresh' };
    case 'set_up':
      return { label: STATE_LABELS.set_up, tone: 'info', icon: 'dashed-circle' };
    case 'manual':
      return { label: STATE_LABELS.manual, tone: 'neutral', icon: 'external-link' };
    case 'planned':
      return { label: STATE_LABELS.planned, tone: 'planned', icon: 'calendar' };
  }
}

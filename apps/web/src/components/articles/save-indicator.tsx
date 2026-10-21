'use client';

import { AlertTriangle, Check, CloudOff, Loader2, PencilLine, Split } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ControllerStatus } from '@/lib/autosave';
import { cn } from '@/lib/utils';

function clock(timestamp: number | null): string {
  return timestamp ? new Date(timestamp).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' }) : '';
}

/** One line that always says whether your words are safe. Announced politely to screen readers. */
export function SaveIndicator({ status, onRetry }: { status: ControllerStatus; onRetry(): void }) {
  let icon: ReactNode;
  let text: string;
  let tone = 'text-muted-foreground';
  let action: ReactNode = null;

  switch (status.state) {
    case 'saved':
      icon = <Check aria-hidden className="size-4 text-success" />;
      text = status.savedAt ? `Saved at ${clock(status.savedAt)}` : 'All changes saved';
      if (Object.keys(status.fieldErrors).length > 0) {
        icon = <AlertTriangle aria-hidden className="size-4 text-warning" />;
        text = 'Saved, but one field was not accepted';
        tone = 'text-warning';
      }
      break;
    case 'dirty':
      icon = <PencilLine aria-hidden className="size-4" />;
      text = 'Unsaved changes';
      break;
    case 'saving':
      icon = <Loader2 aria-hidden className="size-4 animate-spin" />;
      text = 'Saving...';
      break;
    case 'offline':
      icon = <CloudOff aria-hidden className="size-4 text-warning" />;
      text = 'Offline. Your changes are kept here and will be saved when you are back.';
      tone = 'text-warning';
      action = (
        <button type="button" onClick={onRetry} className="underline underline-offset-2 hover:no-underline">
          Retry now
        </button>
      );
      break;
    case 'error':
      icon = <AlertTriangle aria-hidden className="size-4 text-destructive" />;
      text = status.message ?? 'Could not save.';
      tone = 'text-destructive';
      action =
        status.retryInMs !== null ? (
          <button type="button" onClick={onRetry} className="underline underline-offset-2 hover:no-underline">
            Retry now
          </button>
        ) : null;
      break;
    case 'conflict':
      icon = <Split aria-hidden className="size-4 text-destructive" />;
      text = 'Changed elsewhere. Choose which version to keep.';
      tone = 'text-destructive';
      break;
  }

  return (
    <p role="status" aria-live="polite" className={cn('flex min-w-0 items-center gap-1.5 text-xs sm:text-sm', tone)}>
      {icon}
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
      {action}
    </p>
  );
}

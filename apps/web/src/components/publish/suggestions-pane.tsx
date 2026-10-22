'use client';

import { AlertTriangle, Info, Loader2, OctagonAlert, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormNotice } from '@/components/ui/field';
import { StatusChip } from '@/components/ui/status-chip';
import { api } from '@/lib/api-client';
import type { TaskDTO } from '@/lib/ai';
import { PLATFORMS, type DestinationDTO } from '@/lib/publishing';
import { cn } from '@/lib/utils';
import { startTask, type AiState } from './ai-assist';

const SEVERITY = {
  info: { label: 'Note', icon: Info, cls: 'text-muted-foreground' },
  warning: { label: 'Check', icon: AlertTriangle, cls: 'text-warning' },
  error: { label: 'Problem', icon: OctagonAlert, cls: 'text-danger' },
} as const;

/** The right column: an editor’s review of the article (AI, optional) and the checks that need no AI at all. */
export function SuggestionsPane({
  articleId,
  destinations,
  ai,
  onJump,
  onOpen,
  canonicalState,
  onCheckCanonical,
  checkingCanonical,
}: {
  articleId: string;
  destinations: DestinationDTO[];
  ai: AiState;
  onJump(quote: string): void;
  onOpen(platform: DestinationDTO['platform']): void;
  canonicalState: { text: string; tone: 'ok' | 'warn' | 'none' };
  onCheckCanonical(): void;
  checkingCanonical: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviews = ai.tasks.filter((t) => (t.kind === 'review_notes' || t.kind === 'check_accuracy') && !t.draftId && t.status !== 'rejected').slice(0, 3);
  const added = destinations.filter((d) => d.added && d.draft);

  async function review() {
    setBusy(true);
    setError(null);
    const result = await startTask(articleId, ai.revision, 'review_notes', null);
    setBusy(false);
    if (result.ok) ai.merge(result.task);
    else setError(result.error);
  }

  async function dismiss(task: TaskDTO) {
    await api(`/api/ai/tasks/${task.id}/${task.status === 'needs_review' ? 'accept' : 'reject'}`, { method: 'POST', json: task.status === 'needs_review' ? { expectedRevision: ai.revision } : {} });
    await ai.reload();
  }

  return (
    <section aria-label="Suggestions" className="grid content-start gap-6 px-4 py-4">
      <div className="grid gap-3">
        <h2 className="text-sm font-semibold">Editor’s review</h2>
        {ai.available ? (
          <>
            <div>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void review()}>
                <Sparkles aria-hidden />
                {busy ? 'Asking' : 'Review this article'}
              </Button>
            </div>
            {error ? <FormNotice tone="error">{error}</FormNotice> : null}
            {reviews.length === 0 ? <p className="text-sm text-muted-foreground">Ask for a review of structure, clarity and claims that are not supported. Nothing changes your article.</p> : null}
            {reviews.map((task) => (
              <div key={task.id} className="grid gap-2 rounded-xl border bg-surface p-3">
                {task.status === 'running' || task.status === 'pending' ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
                    {task.waiting ? 'Waiting for your Claude Code.' : 'Reading the article…'}
                  </p>
                ) : null}
                {task.status === 'failed' ? <p className="text-sm text-danger">{task.error ?? 'The review failed.'}</p> : null}
                {task.result?.operations.map((op, i) =>
                  op.type === 'review_notes' ? (
                    <ul key={i} className="grid gap-2" aria-label="Review notes">
                      {op.notes.map((note, j) => {
                        const s = SEVERITY[note.severity];
                        return (
                          <li key={j} className="rounded-lg border bg-background p-2.5 text-sm">
                            <p className={cn('flex items-center gap-1.5 text-xs font-semibold', s.cls)}>
                              <s.icon aria-hidden className="size-3.5" />
                              {s.label}
                            </p>
                            {note.quote ? <blockquote className="mt-1 border-l-2 pl-2 text-xs italic text-muted-foreground">{note.quote}</blockquote> : null}
                            <p className="mt-1 leading-5">{note.note}</p>
                            {note.quote ? (
                              <Button type="button" size="xs" variant="ghost" className="mt-1" onClick={() => onJump(note.quote)}>
                                Show in the article
                              </Button>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null,
                )}
                {task.status === 'needs_review' ? (
                  <div>
                    <Button type="button" size="xs" variant="outline" onClick={() => void dismiss(task)}>
                      Mark as read
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </>
        ) : (
          <div className="grid gap-2 rounded-xl border border-dashed p-3 text-sm leading-6">
            <p className="font-medium">AI suggestions are off</p>
            <p className="text-muted-foreground">Set up a local model, your own key or your own Claude Code to get an editor’s review, title ideas and adapted versions. The checks below need no AI.</p>
            <Link href="/settings/ai" className="w-fit font-medium text-link underline underline-offset-2">
              Set up AI
            </Link>
          </div>
        )}
      </div>

      <div className="grid gap-3">
        <h2 className="text-sm font-semibold">Checks that need no AI</h2>
        <div className="rounded-xl border bg-surface p-3 text-sm">
          <p className="font-medium">Canonical page</p>
          <p className={cn('mt-0.5 text-xs leading-5', canonicalState.tone === 'warn' ? 'text-warning' : canonicalState.tone === 'ok' ? 'text-success' : 'text-muted-foreground')}>{canonicalState.text}</p>
          <Button type="button" size="xs" variant="outline" className="mt-2" disabled={checkingCanonical} onClick={onCheckCanonical}>
            {checkingCanonical ? 'Checking' : 'Check the page now'}
          </Button>
        </div>
        {added.length === 0 ? <p className="text-sm text-muted-foreground">Add a destination to see its checks: length, links, tags and images.</p> : null}
        {added.map((d) => {
          const errors = d.draft!.lint.filter((i) => i.severity === 'error');
          const warnings = d.draft!.lint.filter((i) => i.severity === 'warning');
          return (
            <div key={d.platform} className="rounded-xl border bg-surface p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">{PLATFORMS[d.platform].name}</p>
                {errors.length > 0 ? <StatusChip chip={{ label: `${errors.length} to fix`, tone: 'danger', icon: 'alert-circle' }} /> : <StatusChip chip={{ label: 'No blocking problems', tone: 'success', icon: 'check-circle' }} />}
              </div>
              {errors.concat(warnings).slice(0, 3).map((i) => (
                <p key={i.code} className="mt-1 text-xs leading-5 text-muted-foreground">
                  {i.severity === 'error' ? 'Fix: ' : 'Heads up: '}
                  {i.message}
                </p>
              ))}
              {errors.length + warnings.length > 3 ? <p className="mt-1 text-xs text-muted-foreground">and {errors.length + warnings.length - 3} more</p> : null}
              <Button type="button" size="xs" variant="ghost" className="mt-1" onClick={() => onOpen(d.platform)}>
                Open {PLATFORMS[d.platform].name}
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

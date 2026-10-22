'use client';

import { Check, Copy, Loader2, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import { relativeTime } from '@/components/articles/history-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { STATUS_LABELS, TASK_KIND_LABELS, type TaskDTO } from '@/lib/ai';
import { cn } from '@/lib/utils';
import { acceptLabel, ResultView } from './result-view';

export interface TaskActions {
  accept(task: TaskDTO, titleIndex: number | null): Promise<{ ok: true } | { ok: false; error: string }>;
  reject(task: TaskDTO): Promise<{ ok: true } | { ok: false; error: string }>;
  retry(task: TaskDTO): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Open the dialog that shows the exact text a private note would be sent with. */
  reviewPrivate(task: TaskDTO): void;
}

const STATUS_STYLE: Record<TaskDTO['status'], string> = {
  pending: 'border-input text-muted-foreground',
  running: 'border-primary/60 text-link',
  needs_review: 'border-success/60 text-success',
  accepted: 'border-success/60 text-success',
  rejected: 'border-input text-muted-foreground',
  failed: 'border-destructive/60 text-destructive',
};

function usageLine(task: TaskDTO): string | null {
  const { usage } = task;
  const parts: string[] = [];
  if (usage.fromCache) parts.push('answered from an earlier identical request, nothing sent');
  else if (usage.tokensIn !== null || usage.tokensOut !== null) {
    const total = (usage.tokensIn ?? 0) + (usage.tokensOut ?? 0);
    parts.push(`${total.toLocaleString('en')} tokens${usage.estimated ? ' (estimated)' : ''}`);
  }
  if (usage.model) parts.push(usage.model);
  if (parts.length === 0) return null;
  return parts.join(' · ');
}

/** One AI task: what was asked, how it is going, and, when a result is ready, the diff or list to accept or reject. */
export function TaskCard({ task, actions }: { task: TaskDTO; actions: TaskActions }) {
  const [titleIndex, setTitleIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState<'accept' | 'reject' | 'retry' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const waitingForAgent = task.waiting;
  const working = task.status === 'running' || (task.status === 'pending' && !waitingForAgent);
  const decision = task.result ? acceptLabel(task.result) : null;
  const instruction = `In Claude Code: list my Brand OS AI tasks and complete task ${task.id}`;
  const usage = usageLine(task);

  async function run(kind: 'accept' | 'reject' | 'retry', fn: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setBusy(kind);
    setError(null);
    const outcome = await fn();
    setBusy(null);
    if (!outcome.ok) setError(outcome.error);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(instruction);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <li className="rounded-xl border bg-background p-3" data-testid="ai-task" data-status={task.status}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold">{TASK_KIND_LABELS[task.kind]}</span>
        <Badge variant="outline" className={cn('gap-1', STATUS_STYLE[task.status])}>
          {task.status === 'running' ? <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" /> : null}
          {waitingForAgent ? 'Waiting for Claude Code' : STATUS_LABELS[task.status]}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground" title={new Date(task.updatedAt).toLocaleString('en')}>
          {relativeTime(task.updatedAt)}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {task.provider.name ?? 'Provider removed'}
        {task.selection ? ` · ${task.selection.end - task.selection.start} characters selected` : ' · start of the article'}
      </p>
      {task.instruction ? <p className="mt-1.5 text-sm italic text-foreground/90">&ldquo;{task.instruction}&rdquo;</p> : null}
      <p className="mt-1.5 line-clamp-2 break-words rounded border-l-2 pl-2 text-xs text-muted-foreground" title={task.excerpt}>
        {task.excerpt}
      </p>

      {working ? (
        <div className="mt-3 flex items-center justify-between gap-2" role="status">
          <span className="text-sm text-muted-foreground">{task.status === 'running' ? 'The model is working. You can keep writing.' : 'Starting.'}</span>
          <Button type="button" size="xs" variant="ghost" disabled={busy !== null} onClick={() => void run('reject', () => actions.reject(task))}>
            <X aria-hidden />
            Cancel
          </Button>
        </div>
      ) : null}

      {waitingForAgent ? (
        <div className="mt-3 grid gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
          <p className="leading-relaxed text-muted-foreground">
            This task is waiting in your inbox. Nothing runs in this app. Ask your own Claude Code (with the Brand OS server connected) to pick it up; the result comes back here for your review.
          </p>
          <code className="break-words rounded bg-background px-2 py-1.5 font-mono text-xs">{instruction}</code>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="xs" variant="outline" onClick={() => void copy()}>
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? 'Copied' : 'Copy instruction'}
            </Button>
            <Button type="button" size="xs" variant="ghost" disabled={busy !== null} onClick={() => void run('reject', () => actions.reject(task))}>
              Cancel task
            </Button>
          </div>
        </div>
      ) : null}

      {task.status === 'failed' ? (
        <div className="mt-3 grid gap-2">
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {task.error ?? 'The task failed.'}
          </p>
          {task.provider.kind === 'local' || task.provider.kind === 'api_key' ? (
            <div>
              <Button type="button" size="xs" variant="outline" disabled={busy !== null} onClick={() => void run('retry', () => actions.retry(task))}>
                {busy === 'retry' ? 'Starting' : 'Run again'}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {task.status === 'rejected' && task.error ? <p className="mt-2 text-xs text-muted-foreground">{task.error}</p> : null}

      {task.result && (task.status === 'needs_review' || task.status === 'accepted' || task.status === 'rejected') ? (
        <div className={cn('mt-3 grid gap-3', task.status !== 'needs_review' && 'opacity-80')}>
          {task.status === 'needs_review' && task.stale ? (
            <p role="alert" className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
              <strong className="font-semibold">Out of date.</strong> {task.stale}
            </p>
          ) : null}
          {task.status === 'accepted' ? <p className="text-xs font-medium text-success">Applied to the article as a new version.</p> : null}
          <ResultView result={task.result} titleIndex={titleIndex} onTitleIndex={setTitleIndex} />
          {task.status === 'needs_review' && decision ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy !== null || Boolean(task.stale) || (decision.needsTitle && titleIndex === null)}
                onClick={() => void run('accept', () => actions.accept(task, titleIndex))}
              >
                <Check aria-hidden />
                {busy === 'accept' ? 'Applying' : decision.label}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('reject', () => actions.reject(task))}>
                {decision.rejectLabel}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {task.withheldCount > 0 ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg border bg-muted/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            {task.withheldCount} related private {task.withheldCount === 1 ? 'note was' : 'notes were'} not sent. Only text you selected and notes marked for public use go to an outside provider.
            {task.status === 'needs_review' || task.status === 'failed' || task.status === 'accepted' || task.status === 'rejected' ? (
              <Button type="button" variant="link" size="xs" className="h-auto px-1 py-0 text-xs" onClick={() => actions.reviewPrivate(task)}>
                Review what would be sent with them
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {task.notes.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Notes used: {task.notes.map((n) => `${n.title}${n.viaApproval ? ' (approved by you)' : ''}`).join(', ')}
        </p>
      ) : null}
      {usage ? <p className="mt-2 text-xs text-muted-foreground">{usage}</p> : null}
    </li>
  );
}

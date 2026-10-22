'use client';

import { Loader2, Sparkles, WandSparkles } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ProposalView, ResultView } from '@/components/ai/result-view';
import { Button } from '@/components/ui/button';
import { FormNotice } from '@/components/ui/field';
import { api } from '@/lib/api-client';
import { STATUS_LABELS, TASK_KIND_LABELS, type TaskDTO, type TaskKind } from '@/lib/ai';
import type { Operation } from '@/lib/ai-ops';
import type { PlatformDraftDTO } from '@/lib/publishing';
import { cn } from '@/lib/utils';

export interface AiState {
  /** At least one provider is ready to take tasks. */
  available: boolean;
  tasks: TaskDTO[];
  revision: number;
  reload(): Promise<void>;
  merge(task: TaskDTO): void;
}

const FIELD_LABELS = { title: 'Title', description: 'Description', tags: 'Tags', intro: 'Opening', body: 'Whole body' } as const;
type FieldKey = keyof typeof FIELD_LABELS;

/** Start a task for the article, optionally bound to one destination. Nothing is applied until the owner accepts. */
export async function startTask(articleId: string, revision: number, kind: TaskKind, draftId: string | null): Promise<{ ok: true; task: TaskDTO } | { ok: false; error: string }> {
  const result = await api<TaskDTO>('/api/ai/tasks', { json: { articleId, kind, expectedRevision: revision, ...(draftId ? { draftId } : {}) } });
  return result.ok ? { ok: true, task: result.data } : { ok: false, error: result.network ? 'Could not reach the server.' : result.error };
}

function ProposalCard({ task, draft, ai, onApplied }: { task: TaskDTO; draft: PlatformDraftDTO; ai: AiState; onApplied(): void }) {
  const [titleIndex, setTitleIndex] = useState<number | null>(null);
  const [picked, setPicked] = useState<Set<FieldKey>>(new Set(['title', 'description', 'tags', 'intro', 'body']));
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proposal = task.result?.operations.find((o): o is Extract<Operation, { type: 'adapt_proposal' }> => o.type === 'adapt_proposal');
  const titles = task.result?.operations.find((o) => o.type === 'suggest_titles');

  async function decide(kind: 'accept' | 'reject') {
    setBusy(kind);
    setError(null);
    const result =
      kind === 'accept'
        ? await api<{ task: TaskDTO }>(`/api/ai/tasks/${task.id}/accept`, { json: { expectedRevision: ai.revision, ...(titleIndex !== null ? { titleIndex } : {}), ...(proposal ? { fields: [...picked] } : {}) } })
        : await api<TaskDTO>(`/api/ai/tasks/${task.id}/reject`, { method: 'POST', json: {} });
    setBusy(null);
    if (!result.ok) {
      setError(result.network ? 'Could not reach the server.' : result.error);
      await ai.reload();
      return;
    }
    await ai.reload();
    if (kind === 'accept') onApplied();
  }

  const stale = task.stale;
  return (
    <li className="rounded-xl border bg-background p-3" data-testid="proposal" data-status={task.status}>
      <p className="text-sm font-semibold">
        {TASK_KIND_LABELS[task.kind]} <span className="font-normal text-muted-foreground">· {STATUS_LABELS[task.status]}</span>
      </p>
      {task.status === 'running' || task.status === 'pending' ? (
        <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          {task.waiting ? 'Waiting for your Claude Code to pick it up.' : 'Working. You can keep editing.'}
        </p>
      ) : null}
      {task.status === 'failed' ? <p className="mt-1 text-sm text-danger">{task.error ?? 'It failed.'}</p> : null}
      {task.status === 'needs_review' && task.result ? (
        <div className="mt-3 grid gap-3">
          {stale ? <FormNotice tone="error">{stale}</FormNotice> : null}
          {proposal ? (
            <>
              <ProposalView op={proposal} current={{ title: draft.payload.title, description: draft.payload.description, tags: draft.payload.tags, bodyMarkdown: draft.payload.bodyMarkdown }} />
              <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <legend className="mb-1 text-xs font-medium text-muted-foreground">Apply these parts</legend>
                {(Object.keys(FIELD_LABELS) as FieldKey[])
                  .filter((key) => (key === 'intro' ? proposal.intro !== undefined : key === 'body' ? proposal.body !== undefined : proposal[key] !== undefined))
                  .map((key) => (
                    <label key={key} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={picked.has(key)}
                        onChange={(e) =>
                          setPicked((current) => {
                            const next = new Set(current);
                            if (e.target.checked) next.add(key);
                            else next.delete(key);
                            return next;
                          })
                        }
                        className="size-4 accent-[var(--primary)]"
                      />
                      {FIELD_LABELS[key]}
                    </label>
                  ))}
              </fieldset>
            </>
          ) : titles ? (
            <ResultView result={task.result} titleIndex={titleIndex} onTitleIndex={setTitleIndex} />
          ) : null}
          {error ? <FormNotice tone="error">{error}</FormNotice> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={busy !== null || Boolean(stale) || (Boolean(titles) && titleIndex === null) || (Boolean(proposal) && picked.size === 0)} onClick={() => void decide('accept')}>
              {busy === 'accept' ? 'Applying' : titles ? 'Use this title' : 'Apply to this destination'}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void decide('reject')}>
              Reject
            </Button>
            <span className="text-xs text-muted-foreground">Applying is an edit: it makes a new version of this post and voids any approval.</span>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * AI help for one destination, from the same task inbox and privacy gate as the studio. Nothing is applied on its own:
 * a proposal is shown as a diff and changes the destination only when accepted. Without AI it says how to turn it on
 * and points at the checks that need none.
 */
export function AiAssist({ articleId, draft, ai, onApplied }: { articleId: string; draft: PlatformDraftDTO; ai: AiState; onApplied?: () => void }) {
  const [busy, setBusy] = useState<TaskKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mine = ai.tasks.filter((t) => t.draftId === draft.id && (t.kind === 'adapt_for_platform' || t.kind === 'suggest_titles')).slice(0, 4);

  async function ask(kind: TaskKind) {
    setBusy(kind);
    setError(null);
    const result = await startTask(articleId, ai.revision, kind, draft.id);
    setBusy(null);
    if (result.ok) ai.merge(result.task);
    else setError(result.error);
  }

  if (!ai.available) {
    return (
      <section aria-label="AI suggestions" className="grid gap-2 rounded-xl border p-3 text-sm leading-6">
        <p className="flex items-center gap-2 font-semibold">
          <Sparkles aria-hidden className="size-4 text-muted-foreground" />
          AI suggestions are off
        </p>
        <p className="text-muted-foreground">
          Add a local model, your own key, or hand tasks to your own Claude Code to get title ideas, an adapted version for this destination and an editor’s review. Everything else here works without AI.
        </p>
        <Link href="/settings/ai" className="w-fit font-medium text-link underline underline-offset-2">
          Set up AI
        </Link>
      </section>
    );
  }
  return (
    <section aria-label="AI suggestions" className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void ask('adapt_for_platform')}>
          <WandSparkles aria-hidden />
          {busy === 'adapt_for_platform' ? 'Asking' : 'Adapt for this destination'}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void ask('suggest_titles')}>
          {busy === 'suggest_titles' ? 'Asking' : 'Suggest titles'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Your selected knowledge notes stay private unless they are marked for public use. Nothing is applied until you accept.</p>
      {error ? <FormNotice tone="error">{error}</FormNotice> : null}
      {mine.length > 0 ? (
        <ul className={cn('grid gap-2')}>
          {mine.map((task) => (
            <ProposalCard key={task.id} task={task} draft={draft} ai={ai} onApplied={() => onApplied?.()} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

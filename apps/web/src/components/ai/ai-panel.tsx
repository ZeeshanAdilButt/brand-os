'use client';

import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { EditorSelectionInfo } from '@/components/articles/markdown-editor';
import { Button } from '@/components/ui/button';
import { Select, Textarea } from '@/components/ui/field';
import { TASK_LIMITS, type ReadyProvider, type TaskDTO } from '@/lib/ai';
import { TaskCard, type TaskActions } from './task-card';
import type { StreamState } from './use-task-stream';

const VISIBLE = 8;

interface Props {
  providers: ReadyProvider[];
  tasks: TaskDTO[];
  loaded: boolean;
  stream: StreamState;
  selection: EditorSelectionInfo | null;
  onAsk(instruction: string, providerId: string | null): Promise<{ ok: true } | { ok: false; error: string }>;
  actions: TaskActions;
  askRef: React.RefObject<HTMLTextAreaElement | null>;
}

/** The AI side panel: ask something about the selection, and review every task for this article. */
export function AiPanel({ providers, tasks, loaded, stream, selection, onAsk, actions, askRef }: Props) {
  const [instruction, setInstruction] = useState('');
  const [providerId, setProviderId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const available = providers.length > 0;
  const shown = showAll ? tasks : tasks.slice(0, VISIBLE);

  async function ask(event: React.SyntheticEvent) {
    event.preventDefault();
    if (!instruction.trim() || busy) return;
    setBusy(true);
    setError(null);
    const outcome = await onAsk(instruction.trim(), providerId || null);
    setBusy(false);
    if (outcome.ok) setInstruction('');
    else setError(outcome.error);
  }

  const selectionNote = selection
    ? selection.end - selection.start > TASK_LIMITS.excerpt
      ? `The selection is longer than ${TASK_LIMITS.excerpt.toLocaleString('en')} characters. Select less.`
      : `Applies to your selection (${(selection.end - selection.start).toLocaleString('en')} characters).`
    : 'Nothing is selected, so it reads the start of the article.';

  return (
    <div className="flex min-h-0 flex-col gap-5">
      {available ? (
        <form onSubmit={ask} className="grid gap-2" aria-label="Ask a question">
          <label htmlFor="ai-ask" className="text-sm font-medium">
            Ask about your text
          </label>
          <Textarea
            id="ai-ask"
            ref={askRef}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            maxLength={TASK_LIMITS.instruction}
            placeholder="For example: explain this more simply, or add a short example"
            className="min-h-20 text-sm"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void ask(e);
            }}
          />
          <p className="text-xs text-muted-foreground">{selectionNote}</p>
          {providers.length > 1 ? (
            <div className="grid gap-1">
              <label htmlFor="ai-provider" className="text-xs font-medium">
                Run with
              </label>
              <Select id="ai-provider" value={providerId} onChange={(e) => setProviderId(e.target.value)} className="h-9 text-sm">
                <option value="">Default ({providers.find((p) => p.isDefault)?.name ?? providers[0]?.name})</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.executes ? '' : ' (waits for Claude Code)'}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div>
            <Button type="submit" size="sm" disabled={busy || !instruction.trim()}>
              <Sparkles aria-hidden />
              {busy ? 'Starting' : 'Ask'}
            </Button>
          </div>
        </form>
      ) : (
        <div className="rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed">
          <p className="font-medium">AI is off</p>
          <p className="mt-1 text-muted-foreground">
            Everything in the studio works without it. To get help with a selection, add a provider: a model on your machine, your own API key, or your own Claude Code.
          </p>
          <Link href="/settings/ai" className="mt-3 inline-flex h-8 items-center rounded-md border bg-background px-3 text-sm font-medium hover:bg-accent">
            Set up AI
          </Link>
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Tasks for this article</h3>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {stream === 'live' ? 'Live' : stream === 'polling' ? 'Checking every few seconds' : 'Connecting'}
          </span>
        </div>
        {!loaded ? <p className="text-sm text-muted-foreground">Loading.</p> : null}
        {loaded && tasks.length === 0 ? (
          <p className="rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed text-muted-foreground">
            {available ? 'No tasks yet. Select some text and choose Improve, Tighten or Check accuracy, or ask something above.' : 'No tasks yet.'}
          </p>
        ) : null}
        <ul className="grid gap-3">
          {shown.map((task) => (
            <TaskCard key={task.id} task={task} actions={actions} />
          ))}
        </ul>
        {tasks.length > VISIBLE && !showAll ? (
          <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setShowAll(true)}>
            Show all {tasks.length} tasks
          </Button>
        ) : null}
      </div>
    </div>
  );
}

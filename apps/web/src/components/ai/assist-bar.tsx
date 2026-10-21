'use client';

import { FileText, ListTree, Scissors, ShieldCheck, Sparkles, Type } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { TASK_LIMITS, type TaskKind } from '@/lib/ai';

interface Props {
  /** At least one provider is ready. */
  available: boolean;
  /** Characters currently selected in the editor, 0 for none. */
  selectedChars: number;
  /** A task is being created right now. */
  busy: boolean;
  onRun(kind: TaskKind): void;
  onAsk(): void;
}

/**
 * The assist row under the formatting toolbar. Selection actions are enabled only with a selection; when AI
 * is off the row says so and links to the setup instead of showing buttons that cannot work.
 */
export function AssistBar({ available, selectedChars, busy, onRun, onAsk }: Props) {
  if (!available) {
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
        <Sparkles aria-hidden className="size-3.5 shrink-0" />
        <span>AI is off. Everything here works without it.</span>
        <Link href="/settings/ai" className="font-medium text-link underline-offset-2 hover:underline">
          Set up AI to get help with a selection
        </Link>
      </div>
    );
  }
  const hasSelection = selectedChars > 0;
  const tooLong = selectedChars > TASK_LIMITS.excerpt;
  const needSelection = !hasSelection ? 'Select some text first' : tooLong ? `Select at most ${TASK_LIMITS.excerpt.toLocaleString('en')} characters` : undefined;
  const selectionButtons: { kind: TaskKind; label: string; icon: typeof Type; title: string }[] = [
    { kind: 'improve_section', label: 'Improve', icon: Type, title: 'Improve this section: clearer and more precise, same meaning' },
    { kind: 'tighten_intro', label: 'Tighten', icon: Scissors, title: 'Tighten: cut filler, keep every fact' },
    { kind: 'check_accuracy', label: 'Check accuracy', icon: ShieldCheck, title: 'Check technical accuracy: notes only, no rewrite' },
  ];
  return (
    <div role="toolbar" aria-label="AI assistance" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/30 px-2 py-1.5">
      <span className="mr-1 flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
        <Sparkles aria-hidden className="size-3.5" />
        AI
      </span>
      {selectionButtons.map((b) => (
        <Button
          key={b.kind}
          type="button"
          size="xs"
          variant="outline"
          disabled={busy || Boolean(needSelection)}
          title={needSelection ?? b.title}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onRun(b.kind)}
          className="shrink-0"
        >
          <b.icon aria-hidden />
          {b.label}
        </Button>
      ))}
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
      <Button type="button" size="xs" variant="outline" disabled={busy} title="Suggest titles for this article" onClick={() => onRun('suggest_titles')} className="shrink-0">
        <FileText aria-hidden />
        Suggest titles
      </Button>
      <Button type="button" size="xs" variant="outline" disabled={busy} title="Propose a heading outline" onClick={() => onRun('outline')} className="shrink-0">
        <ListTree aria-hidden />
        Outline
      </Button>
      <Button type="button" size="xs" variant="ghost" disabled={busy} title="Ask about your text" onMouseDown={(e) => e.preventDefault()} onClick={onAsk} className="shrink-0">
        Ask&hellip;
      </Button>
      {hasSelection ? (
        <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{selectedChars.toLocaleString('en')} selected</span>
      ) : (
        <span className="ml-auto hidden shrink-0 pl-2 text-xs text-muted-foreground sm:inline">Select text to improve, tighten or check it</span>
      )}
    </div>
  );
}

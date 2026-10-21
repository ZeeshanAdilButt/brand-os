'use client';

import { AlertTriangle, Info, OctagonAlert } from 'lucide-react';
import { useId, useMemo } from 'react';
import type { Operation, TaskResult } from '@/lib/ai-ops';
import { diffWords } from '@/lib/diff';
import { cn } from '@/lib/utils';

/** A rewritten passage with the changed words marked inline: removed words struck through, added words highlighted. */
export function WordDiff({ original, proposed }: { original: string; proposed: string }) {
  const segments = useMemo(() => diffWords(original, proposed), [original, proposed]);
  const changed = segments.some((s) => s.kind !== 'equal');
  if (!changed) return <p className="rounded-md border bg-muted/40 px-3 py-3 text-sm text-muted-foreground">The proposed text is the same as the original.</p>;
  return (
    <div className="rounded-md border bg-background px-3 py-2.5 text-sm leading-relaxed" role="group" aria-label="Proposed change, with removed and added words marked">
      <p className="whitespace-pre-wrap break-words">
        {segments.map((segment, i) =>
          segment.kind === 'equal' ? (
            <span key={i}>{segment.text}</span>
          ) : segment.kind === 'del' ? (
            <del key={i} className="rounded-sm bg-destructive/15 text-destructive line-through decoration-destructive/80">
              {segment.text}
            </del>
          ) : (
            <ins key={i} className="rounded-sm bg-success/20 text-foreground underline decoration-success decoration-2 underline-offset-[3px]">
              {segment.text}
            </ins>
          ),
        )}
      </p>
      <p className="mt-2 border-t pt-1.5 text-[0.6875rem] text-muted-foreground">Struck through: removed. Underlined: added.</p>
    </div>
  );
}

/**
 * A proposal for one destination: each field it would change, as a word diff when the destination's current
 * value is known. Without it (the studio's task list) only the proposed values are shown.
 */
export function ProposalView({ op, current }: { op: Extract<Operation, { type: 'adapt_proposal' }>; current?: { title: string; description: string; tags: string[]; bodyMarkdown: string } | undefined }) {
  const rows: { label: string; node: React.ReactNode }[] = [];
  if (op.title !== undefined) rows.push({ label: 'Title', node: current ? <WordDiff original={current.title} proposed={op.title} /> : <p className="break-words rounded-md border bg-background px-3 py-2 text-sm">{op.title}</p> });
  if (op.description !== undefined) rows.push({ label: 'Description', node: current ? <WordDiff original={current.description} proposed={op.description} /> : <p className="break-words rounded-md border bg-background px-3 py-2 text-sm">{op.description}</p> });
  if (op.tags !== undefined) rows.push({ label: 'Tags', node: current ? <WordDiff original={current.tags.join(', ')} proposed={op.tags.join(', ')} /> : <p className="break-words rounded-md border bg-background px-3 py-2 font-mono text-xs">{op.tags.join(', ') || 'none'}</p> });
  if (op.intro) rows.push({ label: 'Opening', node: <WordDiff original={op.intro.original} proposed={op.intro.proposed} /> });
  if (op.body !== undefined) {
    rows.push({ label: 'Whole body', node: current ? <WordDiff original={current.bodyMarkdown} proposed={op.body} /> : <p className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">A new body of {op.body.length.toLocaleString('en')} characters.</p> });
  }
  return (
    <div className="grid gap-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Proposal for this destination</p>
      {rows.map((row) => (
        <div key={row.label} className="grid gap-1">
          <p className="text-xs font-semibold">{row.label}</p>
          {row.node}
        </div>
      ))}
      {op.rationale ? <p className="text-sm leading-relaxed text-muted-foreground">{op.rationale}</p> : null}
    </div>
  );
}

const SEVERITY = {
  info: { label: 'Note', icon: Info, cls: 'text-muted-foreground' },
  warning: { label: 'Check', icon: AlertTriangle, cls: 'text-warning' },
  error: { label: 'Problem', icon: OctagonAlert, cls: 'text-destructive' },
} as const;

function OperationView({ op, titleIndex, onTitleIndex, name }: { op: Operation; titleIndex: number | null; onTitleIndex(index: number): void; name: string }) {
  if (op.type === 'replace_range') {
    return (
      <div className="grid gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Suggested change</p>
        <WordDiff original={op.original} proposed={op.proposed} />
        {op.rationale ? <p className="text-sm leading-relaxed text-muted-foreground">{op.rationale}</p> : null}
      </div>
    );
  }
  if (op.type === 'suggest_titles') {
    return (
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Suggested titles</legend>
        {op.titles.map((title, i) => (
          <label key={i} className={cn('flex cursor-pointer items-start gap-2 rounded-md border bg-background px-3 py-2 text-sm has-[:checked]:border-primary/60 has-[:checked]:bg-accent')}>
            <input type="radio" name={name} checked={titleIndex === i} onChange={() => onTitleIndex(i)} className="mt-1 accent-[var(--primary)]" />
            <span className="min-w-0 break-words">{title}</span>
          </label>
        ))}
      </fieldset>
    );
  }
  if (op.type === 'review_notes') {
    return (
      <div className="grid gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review notes</p>
        <ul className="grid gap-2">
          {op.notes.map((note, i) => {
            const s = SEVERITY[note.severity];
            return (
              <li key={i} className="rounded-md border bg-background px-3 py-2 text-sm">
                <p className={cn('flex items-center gap-1.5 text-xs font-semibold', s.cls)}>
                  <s.icon aria-hidden className="size-3.5" />
                  {s.label}
                </p>
                {note.quote ? <blockquote className="mt-1 border-l-2 pl-2 text-xs italic text-muted-foreground">{note.quote}</blockquote> : null}
                <p className="mt-1 leading-relaxed">{note.note}</p>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted-foreground">Notes only. Accepting them marks them as read; your text does not change.</p>
      </div>
    );
  }
  if (op.type === 'adapt_proposal') return <ProposalView op={op} />;
  if (op.type === 'insert_after') {
    return (
      <div className="grid gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Text to add after your selection</p>
        <p className="whitespace-pre-wrap break-words rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-sm leading-relaxed">{op.text}</p>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Outline to add</p>
      <ul className="grid gap-1 rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-sm">
        {(op as Extract<Operation, { type: 'outline' }>).headings.map((h, i) => (
          <li key={i} style={{ paddingLeft: `${(h.level - 1) * 0.875}rem` }} className={cn(h.level <= 2 && 'font-medium')}>
            {h.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a waiting result will do, rendered as a diff or a list. Nothing here changes the article. */
export function ResultView({ result, titleIndex, onTitleIndex }: { result: TaskResult; titleIndex: number | null; onTitleIndex(index: number): void }) {
  const name = useId();
  return (
    <div className="grid gap-4">
      {result.operations.map((op, i) => (
        <OperationView key={i} op={op} titleIndex={titleIndex} onTitleIndex={onTitleIndex} name={`${name}-${i}`} />
      ))}
    </div>
  );
}

/** The button label and whether a choice is still needed, from what the result contains. */
export function acceptLabel(result: TaskResult): { label: string; needsTitle: boolean; rejectLabel: string } {
  const types = new Set(result.operations.map((o) => o.type));
  if (types.has('suggest_titles')) return { label: 'Use this title', needsTitle: true, rejectLabel: 'Reject' };
  if (types.has('adapt_proposal')) return { label: 'Apply to the destination', needsTitle: false, rejectLabel: 'Reject' };
  if (types.size === 1 && types.has('review_notes')) return { label: 'Mark as read', needsTitle: false, rejectLabel: 'Dismiss' };
  return { label: 'Accept change', needsTitle: false, rejectLabel: 'Reject' };
}

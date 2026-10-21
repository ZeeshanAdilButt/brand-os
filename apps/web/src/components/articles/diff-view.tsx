'use client';

import { useMemo } from 'react';
import { collapseUnchanged, diffLines, diffStats } from '@/lib/diff';
import { cn } from '@/lib/utils';

/** Counts as chips: how much was added and removed. */
export function DiffStatChips({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs">
      <span className="rounded bg-success/15 px-1.5 py-0.5 text-success">+{added}</span>
      <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-destructive">-{removed}</span>
    </span>
  );
}

/** A unified line diff with line numbers. Long unchanged stretches are folded to a one-line note. */
export function DiffView({ oldText, newText, className }: { oldText: string; newText: string; className?: string }) {
  const { rows, stats } = useMemo(() => {
    const lines = diffLines(oldText, newText);
    return { rows: collapseUnchanged(lines, 3), stats: diffStats(lines) };
  }, [oldText, newText]);

  if (stats.added === 0 && stats.removed === 0) {
    return <p className={cn('rounded-md border bg-muted/40 px-3 py-4 text-sm text-muted-foreground', className)}>These two versions have the same text.</p>;
  }

  return (
    <div className={cn('overflow-x-auto rounded-md border bg-background', className)} role="region" aria-label="Text differences" tabIndex={0}>
      <table className="w-full min-w-max border-collapse font-mono text-xs leading-relaxed">
        <tbody>
          {rows.map((row, index) =>
            row.kind === 'gap' ? (
              <tr key={`gap-${index}`} className="bg-muted/50 text-muted-foreground">
                <td colSpan={4} className="px-3 py-1 text-center font-sans">
                  {row.hidden} unchanged {row.hidden === 1 ? 'line' : 'lines'}
                </td>
              </tr>
            ) : (
              <tr
                key={`${row.kind}-${row.oldNo ?? 'x'}-${row.newNo ?? 'x'}-${index}`}
                className={cn(row.kind === 'add' && 'bg-success/10', row.kind === 'del' && 'bg-destructive/10')}
              >
                <td aria-hidden className="w-10 select-none border-r px-2 text-right text-muted-foreground">
                  {row.oldNo ?? ''}
                </td>
                <td aria-hidden className="w-10 select-none border-r px-2 text-right text-muted-foreground">
                  {row.newNo ?? ''}
                </td>
                <td
                  className={cn(
                    'w-6 select-none px-1 text-center font-bold',
                    row.kind === 'add' && 'text-success',
                    row.kind === 'del' && 'text-destructive',
                  )}
                >
                  <span aria-hidden>{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''}</span>
                  <span className="sr-only">{row.kind === 'add' ? 'Added: ' : row.kind === 'del' ? 'Removed: ' : ''}</span>
                </td>
                <td className="whitespace-pre-wrap break-words pr-3">{row.text === '' ? ' ' : row.text}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

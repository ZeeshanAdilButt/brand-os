'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Draft } from '@/lib/autosave';
import { diffLines, diffStats } from '@/lib/diff';
import { DiffStatChips, DiffView } from './diff-view';

const FIELD_LABELS: Record<Exclude<keyof Draft, 'bodyMarkdown'>, string> = {
  title: 'Title',
  slug: 'Slug',
  description: 'Description',
  tags: 'Tags',
  canonicalUrl: 'Canonical URL',
  coverAssetId: 'Cover image',
  status: 'Status',
};

const show = (value: unknown) => (Array.isArray(value) ? value.join(', ') || 'none' : value === null || value === '' ? 'empty' : String(value));

/**
 * Shown when the server has a newer copy than the one this tab started from. Nothing is
 * overwritten until a choice is made: keep this tab's version, or take the saved one.
 */
export function ConflictDialog({
  open,
  mine,
  theirs,
  onKeepMine,
  onTakeTheirs,
}: {
  open: boolean;
  mine: Draft;
  theirs: Draft | null;
  onKeepMine(): void;
  onTakeTheirs(): void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const summary = useMemo(() => {
    if (!theirs) return null;
    const fields = (Object.keys(FIELD_LABELS) as (keyof typeof FIELD_LABELS)[]).filter((key) => JSON.stringify(mine[key]) !== JSON.stringify(theirs[key]));
    return { fields, stats: diffStats(diffLines(theirs.bodyMarkdown, mine.bodyMarkdown)) };
  }, [mine, theirs]);

  if (!theirs || !summary) return null;
  const bodyDiffers = summary.stats.added > 0 || summary.stats.removed > 0;

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>This article was changed somewhere else</DialogTitle>
          <DialogDescription>
            Another tab or session saved a newer version while you were editing. Nothing has been overwritten. Choose which version to keep; the other one stays in the
            version history either way.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 text-sm">
          <p className="font-medium">What differs</p>
          {summary.fields.length === 0 && !bodyDiffers ? (
            <p className="text-muted-foreground">The two versions hold the same content. Keeping yours just refreshes the connection.</p>
          ) : (
            <ul className="grid gap-1.5">
              {summary.fields.map((key) => (
                <li key={key} className="rounded-md border bg-muted/40 px-3 py-2">
                  <span className="font-medium">{FIELD_LABELS[key]}</span>
                  <span className="mt-1 grid gap-0.5 text-xs text-muted-foreground sm:grid-cols-2">
                    <span className="min-w-0 break-words">Yours: {show(mine[key])}</span>
                    <span className="min-w-0 break-words">Saved: {show(theirs[key])}</span>
                  </span>
                </li>
              ))}
              {bodyDiffers ? (
                <li className="rounded-md border bg-muted/40 px-3 py-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">Text</span>
                    <DiffStatChips added={summary.stats.added} removed={summary.stats.removed} />
                    <span className="text-xs text-muted-foreground">lines in yours compared with the saved version</span>
                  </span>
                  <Button type="button" variant="link" size="sm" className="mt-1 h-auto p-0" onClick={() => setShowDiff((v) => !v)}>
                    {showDiff ? 'Hide the differences' : 'Show the differences'}
                  </Button>
                  {showDiff ? <DiffView oldText={theirs.bodyMarkdown} newText={mine.bodyMarkdown} className="mt-2 max-h-72 overflow-y-auto" /> : null}
                </li>
              ) : null}
            </ul>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={onTakeTheirs}>
            Use the saved version
          </Button>
          <Button type="button" onClick={onKeepMine}>
            Keep my version
          </Button>
        </DialogFooter>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Keeping your version replaces the saved text with what is in this tab. Using the saved version discards the changes in this tab.
        </p>
      </DialogContent>
    </Dialog>
  );
}

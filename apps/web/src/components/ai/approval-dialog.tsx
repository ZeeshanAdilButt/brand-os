'use client';

import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ContextPreviewDTO } from '@/lib/ai';

/**
 * Approve sending private notes for ONE task. It shows the exact text that would be sent, word for word,
 * and the approval is tied to that text: if the text changes before sending, the server refuses it.
 */
export function ApprovalDialog({
  preview,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  preview: ContextPreviewDTO | null;
  busy: boolean;
  error: string | null;
  onConfirm(): void;
  onCancel(): void;
}) {
  const approved = preview ? preview.included.filter((i) => i.viaApproval) : [];
  return (
    <Dialog open={preview !== null} onOpenChange={(open) => (!open && !busy ? onCancel() : undefined)}>
      <DialogContent className="max-h-[90dvh] overflow-hidden sm:max-w-2xl">
        {preview ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldAlert aria-hidden className="size-5 text-warning" />
                Send private notes for this task?
              </DialogTitle>
              <DialogDescription>
                This text goes to <strong>{preview.providerName}</strong>, outside your machine. It includes {approved.length === 1 ? 'one private note' : `${approved.length} private notes`}:{' '}
                {approved.map((i) => i.title).join(', ')}. Your approval covers this one task only.
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-hidden">
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Exactly what will be sent (about {preview.estimatedTokens.toLocaleString('en')} tokens)
              </p>
              <pre
                tabIndex={0}
                aria-label="The exact text that will be sent"
                className="max-h-[45dvh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
              >
                {preview.prompt}
              </pre>
            </div>
            {error ? (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
                Do not send
              </Button>
              <Button type="button" disabled={busy} onClick={onConfirm}>
                {busy ? 'Sending' : 'Send this text'}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

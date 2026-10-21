'use client';

import { CheckCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { deleteItemAction, reviewItemAction } from '@/app/(app)/_actions/knowledge';
import { Button } from '@/components/ui/button';

/** Confirm that the claim is accurate. It records the review date and does not make the item public. */
export function ReviewButton({ id }: { id: string }) {
  return (
    <form action={reviewItemAction}>
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="outline" size="sm">
        <CheckCheck aria-hidden />
        Mark reviewed
      </Button>
    </form>
  );
}

/** Two-step delete: the first click asks, the second removes this one item for good. */
export function DeleteButton({ id, title }: { id: string; title: string }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)} aria-label={`Delete ${title}`}>
        <Trash2 aria-hidden />
        Delete
      </Button>
    );
  }
  return (
    <form action={deleteItemAction} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <span className="text-sm text-muted-foreground">Delete this item for good?</span>
      <Button type="submit" variant="destructive" size="sm">
        Delete
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </form>
  );
}

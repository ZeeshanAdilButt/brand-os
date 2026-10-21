'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createItem, deleteItem, markReviewed, updateItem } from '@/server/actions/knowledge';
import { ActionError, sessionToOwner, splitList } from '@/server/actions/owner';
import { requireSessionUser } from '@/server/auth/session';
import type { FormState } from './form-state';

async function currentOwner() {
  const user = await requireSessionUser();
  return sessionToOwner(user, user.ctx);
}

const text = (data: FormData, key: string) => {
  const value = data.get(key);
  return typeof value === 'string' ? value : '';
};
const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

/** Form fields to item input. The owner is never read from the form: it comes from the session. */
function itemFromForm(data: FormData) {
  return {
    kind: text(data, 'kind'),
    title: text(data, 'title'),
    body: text(data, 'body'),
    tags: splitList(text(data, 'tags'), 20),
    sourceId: orNull(text(data, 'sourceId')),
    sourceDate: orNull(text(data, 'sourceDate')),
    verificationStatus: text(data, 'verificationStatus') || undefined,
    confidence: text(data, 'confidence') || undefined,
    confidentiality: text(data, 'confidentiality') || undefined,
    publicUsePermitted: data.get('publicUsePermitted') === 'on',
  };
}

function toErrorState(err: unknown): FormState {
  if (err instanceof ActionError) return { status: 'error', message: err.message, fields: err.fields };
  throw err;
}

/** Create an item (no id) or update one (id given). Creating returns to the list. */
export async function saveItemAction(_previous: FormState, data: FormData): Promise<FormState> {
  const owner = await currentOwner();
  const id = text(data, 'id');
  try {
    if (id) {
      await updateItem(owner, id, itemFromForm(data));
      revalidatePath('/knowledge', 'layout');
      return { status: 'saved', message: 'Saved.' };
    }
    await createItem(owner, itemFromForm(data));
  } catch (err) {
    return toErrorState(err);
  }
  revalidatePath('/knowledge', 'layout');
  redirect('/knowledge');
}

/** Add a bare item from onboarding: kind, title and notes, with the safe defaults. */
export async function quickAddAction(_previous: FormState, data: FormData): Promise<FormState> {
  const owner = await currentOwner();
  try {
    await createItem(owner, { kind: text(data, 'kind'), title: text(data, 'title'), body: text(data, 'body') });
  } catch (err) {
    return toErrorState(err);
  }
  revalidatePath('/onboarding');
  revalidatePath('/knowledge', 'layout');
  return { status: 'saved', message: 'Added. It is private and unverified until you say otherwise.' };
}

export async function reviewItemAction(data: FormData): Promise<void> {
  const owner = await currentOwner();
  try {
    await markReviewed(owner, text(data, 'id'));
  } catch (err) {
    if (!(err instanceof ActionError)) throw err;
  }
  revalidatePath('/knowledge', 'layout');
}

export async function deleteItemAction(data: FormData): Promise<void> {
  const owner = await currentOwner();
  try {
    await deleteItem(owner, text(data, 'id'));
  } catch (err) {
    if (!(err instanceof ActionError)) throw err;
  }
  revalidatePath('/knowledge', 'layout');
  redirect('/knowledge');
}

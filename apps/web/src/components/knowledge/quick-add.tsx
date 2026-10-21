'use client';

import { useActionState, useEffect, useRef } from 'react';
import { IDLE, type FormState } from '@/app/(app)/_actions/form-state';
import { quickAddAction } from '@/app/(app)/_actions/knowledge';
import { Button } from '@/components/ui/button';
import { Field, FormNotice, Input, Select, Textarea } from '@/components/ui/field';
import { ITEM_KINDS, KIND_LABELS } from '@/lib/knowledge';

const ORDER = ['reading', 'certification', 'project', 'note', ...ITEM_KINDS.filter((k) => !['reading', 'certification', 'project', 'note'].includes(k))] as const;

/** Add a reading note, certification, project or any other item by hand, with the safe defaults. */
export function QuickAdd() {
  const [state, action, pending] = useActionState<FormState, FormData>(quickAddAction, IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status === 'saved') formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
        <Field label="Kind" htmlFor="quick-kind">
          <Select id="quick-kind" name="kind" defaultValue="reading">
            {ORDER.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title" htmlFor="quick-title" hint="For example the book, certificate or project name." error={state.fields?.title}>
          <Input id="quick-title" name="title" required maxLength={200} />
        </Field>
      </div>
      <Field label="Notes" htmlFor="quick-body" hint="Optional. What it was, what you learned, any numbers and how you measured them.">
        <Textarea id="quick-body" name="body" rows={3} maxLength={20000} />
      </Field>
      {state.status === 'error' ? <FormNotice tone="error">{state.message ?? 'Some fields need attention.'}</FormNotice> : null}
      {state.status === 'saved' ? <FormNotice tone="success">{state.message ?? 'Added.'}</FormNotice> : null}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding' : 'Add item'}
        </Button>
      </div>
    </form>
  );
}

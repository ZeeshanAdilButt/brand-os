'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { IDLE, type FormState } from '@/app/(app)/_actions/form-state';
import { saveItemAction } from '@/app/(app)/_actions/knowledge';
import { Button } from '@/components/ui/button';
import { Field, FormNotice, Input, Select, Textarea } from '@/components/ui/field';
import {
  CONFIDENCE_LABELS,
  CONFIDENCE_LEVELS,
  CONFIDENTIALITY_LABELS,
  CONFIDENTIALITY_LEVELS,
  ITEM_KINDS,
  KIND_LABELS,
  VERIFICATION_LABELS,
  VERIFICATION_STATUSES,
  type Confidence,
  type Confidentiality,
  type ItemKind,
  type VerificationStatus,
} from '@/lib/knowledge';

export interface ItemFormValues {
  id?: string;
  kind: ItemKind;
  title: string;
  body: string;
  tags: string[];
  sourceId: string | null;
  sourceDate: string | null;
  verificationStatus: VerificationStatus;
  confidence: Confidence;
  confidentiality: Confidentiality;
  publicUsePermitted: boolean;
}

export const NEW_ITEM: ItemFormValues = {
  kind: 'note',
  title: '',
  body: '',
  tags: [],
  sourceId: null,
  sourceDate: null,
  verificationStatus: 'unverified',
  confidence: 'medium',
  confidentiality: 'private',
  publicUsePermitted: false,
};

/** Create or edit one knowledge item. Defaults are the safe ones: private, unverified, not for public use. */
export function ItemForm({ values, sources }: { values: ItemFormValues; sources: { id: string; title: string }[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveItemAction, IDLE);
  const err = (key: string) => state.fields?.[key];
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <div className="grid gap-5 sm:grid-cols-[1fr_12rem]">
        <Field label="Title" htmlFor="title" error={err('title')}>
          <Input id="title" name="title" defaultValue={values.title} required maxLength={200} aria-invalid={err('title') ? true : undefined} />
        </Field>
        <Field label="Kind" htmlFor="kind" error={err('kind')}>
          <Select id="kind" name="kind" defaultValue={values.kind}>
            {ITEM_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Details" htmlFor="body" hint="What happened, what you learned, the numbers and how you measured them. Plain text." error={err('body')}>
        <Textarea id="body" name="body" defaultValue={values.body} rows={6} maxLength={20000} />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Tags" htmlFor="tags" hint="Comma separated. Tags are searchable.">
          <Input id="tags" name="tags" defaultValue={values.tags.join(', ')} />
        </Field>
        <Field label="Date" htmlFor="sourceDate" hint="When this happened or was published." error={err('sourceDate')}>
          <Input id="sourceDate" name="sourceDate" type="date" defaultValue={values.sourceDate ?? ''} />
        </Field>
      </div>
      <Field label="Source" htmlFor="sourceId" hint={sources.length ? 'Where this came from.' : 'No sources yet. Items you type in by hand need none.'}>
        <Select id="sourceId" name="sourceId" defaultValue={values.sourceId ?? ''}>
          <option value="">No source</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </Select>
      </Field>

      <fieldset className="grid gap-5 rounded-lg border bg-muted/40 p-4 sm:grid-cols-3">
        <legend className="label-caps px-1 text-muted-foreground">Trust and privacy</legend>
        <Field label="Verification" htmlFor="verificationStatus">
          <Select id="verificationStatus" name="verificationStatus" defaultValue={values.verificationStatus}>
            {VERIFICATION_STATUSES.map((v) => (
              <option key={v} value={v}>
                {VERIFICATION_LABELS[v]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Confidence" htmlFor="confidence">
          <Select id="confidence" name="confidence" defaultValue={values.confidence}>
            {CONFIDENCE_LEVELS.map((c) => (
              <option key={c} value={c}>
                {CONFIDENCE_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Confidentiality" htmlFor="confidentiality">
          <Select id="confidentiality" name="confidentiality" defaultValue={values.confidentiality}>
            {CONFIDENTIALITY_LEVELS.map((c) => (
              <option key={c} value={c}>
                {CONFIDENTIALITY_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-start gap-3 text-sm sm:col-span-3">
          <input
            type="checkbox"
            name="publicUsePermitted"
            defaultChecked={values.publicUsePermitted}
            className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
          />
          <span>
            <span className="font-medium">Allow this in public writing</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              Off by default. Nothing marked private or needing review should be quoted in a published article.
            </span>
          </span>
        </label>
      </fieldset>

      {state.status === 'error' ? <FormNotice tone="error">{state.message ?? 'Some fields need attention.'}</FormNotice> : null}
      {state.status === 'saved' ? <FormNotice tone="success">{state.message ?? 'Saved.'}</FormNotice> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving' : values.id ? 'Save changes' : 'Add item'}
        </Button>
        <Button asChild variant="ghost">
          <Link href="/knowledge">Back to knowledge</Link>
        </Button>
      </div>
    </form>
  );
}

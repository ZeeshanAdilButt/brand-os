'use client';

import { useState } from 'react';
import { PLATFORMS, type PlatformId } from '@/lib/catalog';
import type { DraftPayload } from '@/lib/publishing';
import { linksIn } from '@/lib/short-form';
import { Select } from '@/components/ui/field';
import { PlatformPreview, type PreviewInput } from './platform-preview';

export interface Difference {
  label: string;
  a: string;
  b: string;
  same: boolean;
}

const words = (text: string) => (text.match(/[\p{L}\p{N}']+/gu) ?? []).length;

/** What differs between two adapted payloads, for the strip between the previews. */
export function differences(a: DraftPayload, b: DraftPayload): Difference[] {
  const row = (label: string, x: string, y: string): Difference => ({ label, a: x, b: y, same: x === y });
  const tags = (p: DraftPayload) => (p.tags.length ? p.tags.join(', ') : 'none');
  const images = (p: DraftPayload) => String((p.bodyMarkdown.match(/!\[[^\]]*\]\([^)]+\)/g) ?? []).length + (p.coverImageUrl ? 1 : 0));
  return [
    row('Title', a.title || 'empty', b.title || 'empty'),
    row('Words', String(words(a.bodyMarkdown)), String(words(b.bodyMarkdown))),
    row('Links', String(linksIn(a.bodyMarkdown).length), String(linksIn(b.bodyMarkdown).length)),
    row('Images', images(a), images(b)),
    row('Tags', tags(a), tags(b)),
    row('Canonical', a.canonicalUrl ?? 'none', b.canonicalUrl ?? 'none'),
  ];
}

/** Two destinations side by side with the same device width, and a strip of what differs between them. */
export function PreviewComparison({ items, initial }: { items: PreviewInput[]; initial?: [PlatformId, PlatformId] }) {
  const platforms = items.map((i) => i.platform);
  const [left, setLeft] = useState<PlatformId>(initial?.[0] ?? platforms[0]!);
  const [right, setRight] = useState<PlatformId>(initial?.[1] ?? platforms[1] ?? platforms[0]!);
  const a = items.find((i) => i.platform === left) ?? items[0]!;
  const b = items.find((i) => i.platform === right) ?? items[0]!;
  const diffs = differences(a.payload, b.payload);

  if (items.length < 2) {
    return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Choose at least two destinations to compare them.</p>;
  }
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {([['Left', left, setLeft], ['Right', right, setRight]] as const).map(([name, value, set]) => (
          <label key={name} className="grid gap-1 text-sm font-medium">
            {name} destination
            <Select value={value} onChange={(e) => set(e.target.value as PlatformId)}>
              {platforms.map((p) => (
                <option key={p} value={p}>
                  {PLATFORMS[p].name}
                </option>
              ))}
            </Select>
          </label>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <PlatformPreview key={`l-${left}`} input={a} defaultDevice="mobile" />
        <PlatformPreview key={`r-${right}`} input={b} defaultDevice="mobile" />
      </div>
      <div className="overflow-x-auto rounded-lg border bg-surface">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <caption className="border-b px-3 py-2 text-left text-sm font-semibold">What differs</caption>
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-1.5 font-medium">Part</th>
              <th scope="col" className="px-3 py-1.5 font-medium">{PLATFORMS[a.platform].name}</th>
              <th scope="col" className="px-3 py-1.5 font-medium">{PLATFORMS[b.platform].name}</th>
            </tr>
          </thead>
          <tbody>
            {diffs.map((d) => (
              <tr key={d.label} className="border-t">
                <th scope="row" className="px-3 py-1.5 font-medium">{d.label}</th>
                <td className="max-w-[16rem] truncate px-3 py-1.5">{d.a}</td>
                <td className="max-w-[16rem] truncate px-3 py-1.5">
                  {d.b}
                  {d.same ? <span className="ml-2 text-xs text-muted-foreground">same</span> : <span className="ml-2 text-xs font-medium text-warning">differs</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

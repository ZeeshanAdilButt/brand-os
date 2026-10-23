'use client';

import { LayoutGrid, Grid3x3, List } from 'lucide-react';
import { Segmented } from '@/components/ui/segmented';
import type { Density } from '@/lib/view-prefs';

/** How tightly a list of cards is drawn: one row each, a compact grid or a comfortable grid. */
export function DensityToggle({ value, onChange, label = 'Density' }: { value: Density; onChange(value: Density): void; label?: string }) {
  return (
    <Segmented
      label={label}
      value={value}
      onChange={onChange}
      options={[
        { value: 'list', title: 'List: one row each', label: (<><List aria-hidden className="size-4" /><span className="sr-only sm:not-sr-only">List</span></>) },
        { value: 'compact', title: 'Compact grid: more on screen', label: (<><Grid3x3 aria-hidden className="size-4" /><span className="sr-only sm:not-sr-only">Compact</span></>) },
        { value: 'comfortable', title: 'Comfortable grid: room to read', label: (<><LayoutGrid aria-hidden className="size-4" /><span className="sr-only sm:not-sr-only">Comfortable</span></>) },
      ]}
    />
  );
}

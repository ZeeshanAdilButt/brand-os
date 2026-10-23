'use client';

import { CollapsibleArea } from '@/components/ui/collapsible-area';
import { cn } from '@/lib/utils';

export interface CategoryOption {
  id: string;
  label: string;
  count: number;
}

/**
 * The category filter as a column beside the list. It folds into a slim bar that still names the chosen category, so
 * the list can use the room. On a narrow screen the same choices are a row of buttons above the list that folds too.
 * Every button says whether it is the chosen one.
 */
export function CategoryColumn({
  options,
  value,
  onChange,
  collapsed,
  onCollapsedChange,
}: {
  options: CategoryOption[];
  value: string;
  onChange(id: string): void;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
}) {
  const chosen = options.find((o) => o.id === value) ?? options[0];
  return (
    <CollapsibleArea
      title="Categories"
      summary={chosen?.label ?? 'All categories'}
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
      className="p-3 sm:p-3 lg:sticky lg:top-20"
      collapsedClassName="lg:sticky lg:top-20 lg:h-72 lg:self-start"
    >
      <ul aria-label="Categories" className="flex flex-wrap gap-2 pt-1 lg:flex-col lg:gap-0.5">
        {options.map((o) => {
          const on = o.id === value;
          return (
            <li key={o.id}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onChange(o.id)}
                className={cn(
                  'flex h-9 w-full items-center justify-between gap-3 rounded-lg border px-3 text-sm transition-colors duration-[120ms] lg:border-transparent',
                  on ? 'border-primary bg-accent font-semibold text-accent-foreground' : 'bg-surface text-muted-foreground hover:bg-accent hover:text-foreground lg:bg-transparent',
                )}
              >
                <span className="truncate">{o.label}</span>
                <span className="text-xs tabular-nums">{o.count}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </CollapsibleArea>
  );
}

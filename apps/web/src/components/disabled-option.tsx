import type { LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * A feature that is planned but not built. It says which day it arrives and offers a visibly
 * disabled control, so nobody mistakes it for something that works.
 */
export function DisabledOption({
  icon: Icon,
  title,
  description,
  action,
  day,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action: string;
  day: number;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-dashed border-input bg-card/60 p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-[1.125rem]" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-sans text-sm font-semibold">{title}</h3>
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled>
          {action}
        </Button>
        <Badge variant="outline" className="border-input font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
          Not built yet &middot; Arrives Day {day}
        </Badge>
      </div>
    </li>
  );
}

import { Check, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface ComingSoonProps {
  day: number;
  icon: LucideIcon;
  heading: string;
  lead: string;
  items: string[];
  /** What already works in this area today, if anything. */
  today?: string;
}

/** Intentional empty state for a section whose feature is not built yet. No fake data, no dead buttons. */
export function ComingSoon({ day, icon: Icon, heading, lead, items, today }: ComingSoonProps) {
  return (
    <section
      aria-labelledby="coming-soon-heading"
      className="rounded-xl border border-input bg-card/60 p-5 sm:p-8"
    >
      <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
        <div
          aria-hidden
          className="grid size-12 shrink-0 place-items-center rounded-xl border bg-background text-link shadow-soft"
        >
          <Icon className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          <Badge variant="outline" className="mb-3 gap-1.5 border-input font-mono text-[0.6875rem] uppercase tracking-wider">
            Not built yet
            <span aria-hidden>&middot;</span>
            Arrives Day {day}
          </Badge>
          <h2 id="coming-soon-heading" className=" text-2xl font-semibold">
            {heading}
          </h2>
          <p className="mt-2 max-w-2xl leading-relaxed text-muted-foreground">{lead}</p>
          <p className="label-caps mt-6 mb-3 text-muted-foreground">What will live here</p>
          <ul className="grid gap-2.5">
            {items.map((item) => (
              <li key={item} className="flex gap-3 text-sm leading-relaxed">
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-teal-text" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          {today ? (
            <p className="mt-6 rounded-md bg-muted px-3.5 py-2.5 text-sm leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Works today: </span>
              {today}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

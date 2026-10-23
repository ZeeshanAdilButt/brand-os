import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Line art for an empty state, in the language of the logo: one source that branches. Drawn with the current text colour
 * so it stays quiet on any surface, and never carries meaning on its own (it is hidden from screen readers).
 * `branches` sets how many lines leave the source, from two to five.
 */
export function BranchArt({ branches = 3, className }: { branches?: 2 | 3 | 4 | 5; className?: string }) {
  const count = Math.min(5, Math.max(2, branches));
  const top = 14;
  const bottom = 86;
  const ends = Array.from({ length: count }, (_, i) => top + ((bottom - top) * i) / (count - 1));
  return (
    <svg viewBox="0 0 160 100" width="160" height="100" aria-hidden focusable="false" className={cn('text-muted-foreground', className)} fill="none">
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.55">
        {ends.map((y) => (
          <path key={y} d={`M26 50C70 50 76 ${y} 128 ${y}`} />
        ))}
      </g>
      <circle cx="26" cy="50" r="7" fill="currentColor" opacity="0.7" />
      <g fill="var(--surface)" stroke="currentColor" strokeWidth="1.5" opacity="0.8">
        {ends.map((y) => (
          <circle key={y} cx="132" cy={y} r="4.5" />
        ))}
      </g>
    </svg>
  );
}

/** A framed empty state: the branching line art, a short title and one calm sentence, with an optional action below. */
export function EmptyState({ title, children, action, branches = 3, className }: { title: string; children?: ReactNode; action?: ReactNode; branches?: 2 | 3 | 4 | 5; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-3 rounded-xl border bg-surface px-6 py-8 text-center', className)}>
      <BranchArt branches={branches} className="h-16 w-auto" />
      <h3 className="font-display text-lg font-semibold">{title}</h3>
      {children ? <p className="mx-auto max-w-sm text-sm leading-6 text-muted-foreground">{children}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

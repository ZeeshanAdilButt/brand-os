'use client';

import { ChevronDown, ChevronUp, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Class sets for the breakpoint at which a folded area becomes a vertical bar (written out so Tailwind sees every class). */
const BAR = {
  lg: {
    section: 'lg:w-12 lg:self-stretch',
    heading: 'lg:min-h-48',
    button: 'lg:flex-col lg:px-0 lg:py-3.5',
    text: 'lg:max-h-[min(22rem,70dvh)] lg:flex-none lg:[writing-mode:vertical-rl]',
    open: 'hidden lg:block',
    chevron: 'lg:hidden',
  },
  xl: {
    section: 'xl:w-12 xl:self-stretch',
    heading: 'xl:min-h-48',
    button: 'xl:flex-col xl:px-0 xl:py-3.5',
    text: 'xl:max-h-[min(22rem,70dvh)] xl:flex-none xl:[writing-mode:vertical-rl]',
    open: 'hidden xl:block',
    chevron: 'xl:hidden',
  },
} as const;

/**
 * A titled area of a page that can fold away. Folded, it is a slim vertical bar on a wide screen (and a one-line bar
 * on a narrow one) that still says what it holds in one line, and a click on it opens the area again. The body stays
 * mounted while folded, so whatever it was doing (a selection, a live preview) carries on and nothing is lost.
 *
 * `side` is where the bar sits: the left and right columns fold toward their own edge.
 */
export function CollapsibleArea({
  title,
  summary,
  collapsed,
  onCollapsedChange,
  side = 'left',
  badge,
  note,
  actions,
  canCollapse = true,
  flush = false,
  bar = 'lg',
  children,
  className,
  collapsedClassName,
}: {
  title: string;
  /** One line shown in the folded bar, for example the chosen article or "2 platforms selected". */
  summary: string;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  side?: 'left' | 'right';
  /** A small marker before the title, such as the step number. */
  badge?: ReactNode;
  note?: string;
  /** Extra controls in the header while the area is open. */
  actions?: ReactNode;
  /** False hides the fold control, for a moment when folding would make no sense (a full view). */
  canCollapse?: boolean;
  /** The body brings its own padding: the open area has no padding of its own and a slim header bar. */
  flush?: boolean;
  /** The screen width from which the folded bar is vertical; below it the bar is one line across. */
  bar?: 'lg' | 'xl';
  children: ReactNode;
  className?: string;
  /** Extra classes only while folded (the width of the bar on a wide screen, for example). */
  collapsedClassName?: string;
}) {
  const uid = useId();
  const headingId = `${uid}-title`;
  const bodyId = `${uid}-body`;
  const CloseIcon = side === 'left' ? PanelLeftClose : PanelRightClose;
  const b = BAR[bar];
  const OpenIcon = side === 'left' ? PanelLeftOpen : PanelRightOpen;

  return (
    <section aria-labelledby={headingId} className={cn('min-w-0 rounded-xl border bg-surface', collapsed ? cn(b.section, collapsedClassName) : cn(flush ? 'flex flex-col' : 'p-4 sm:p-5', className))}>
      {collapsed ? (
        <h2 id={headingId} className={cn('h-full text-base font-semibold', b.heading)}>
          <button
            type="button"
            aria-expanded={false}
            aria-controls={bodyId}
            onClick={() => onCollapsedChange(false)}
            title={`Open ${title}`}
            className={cn(
              'flex h-full w-full items-center gap-2.5 rounded-xl px-3 py-3 text-left transition-colors duration-[120ms] hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
              b.button,
            )}
          >
            {badge}
            <span className={cn('flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden', b.text)}>
              <span className="shrink-0">{title}</span>
              <span className="min-w-0 truncate text-sm font-normal text-muted-foreground">{summary}</span>
            </span>
            <OpenIcon aria-hidden className={cn('size-4 shrink-0 text-muted-foreground', b.open)} />
            <ChevronDown aria-hidden className={cn('size-4 shrink-0 text-muted-foreground', b.chevron)} />
          </button>
        </h2>
      ) : (
        <div className={cn('flex gap-2.5', flush ? 'items-center border-b px-4 py-2' : 'mb-1 items-start')}>
          <h2 id={headingId} className="flex min-w-0 flex-1 items-center gap-2.5 text-lg font-semibold">
            {badge}
            <span className="min-w-0">{title}</span>
          </h2>
          {actions}
          {canCollapse ? (
            <button
              type="button"
              aria-expanded={true}
              aria-controls={bodyId}
              aria-label={`Fold ${title}`}
              title={`Fold ${title} away`}
              onClick={() => onCollapsedChange(true)}
              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-[120ms] hover:bg-accent hover:text-foreground"
            >
              <CloseIcon aria-hidden className={cn('size-4', b.open)} />
              <ChevronUp aria-hidden className={cn('size-4', b.chevron)} />
            </button>
          ) : null}
        </div>
      )}
      {!collapsed && !flush && note ? <p className="mb-3 text-sm text-muted-foreground">{note}</p> : null}
      {!collapsed && !flush && !note ? <div className="mb-3" /> : null}
      <div id={bodyId} hidden={collapsed} className={flush ? 'min-h-0 flex-1' : undefined}>
        {children}
      </div>
    </section>
  );
}

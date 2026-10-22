import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const LABELS = {
  attention: 'Needs you',
  continue: 'Continue writing',
  start: 'Start here',
} as const;

/**
 * The single next action on Home: a quiet label, the article in serif, one sentence on why this is next and one primary
 * button. Progress sits in the footer of the same card, so there is one container, not two.
 */
export function NextStepCard({
  kicker,
  subject,
  headline,
  why,
  href,
  actionLabel,
  secondary,
  footer,
  className,
}: {
  kicker: keyof typeof LABELS;
  /** The article this is about, shown in serif. Omitted for a fresh start. */
  subject?: string | undefined;
  headline: string;
  why: string;
  href: string;
  actionLabel?: string;
  secondary?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby="next-step-title" className={cn('rounded-xl border border-l-[3px] border-l-primary bg-surface p-6 shadow-sm sm:p-7', className)}>
      <p className="text-[0.8125rem] leading-[1.125rem] font-medium text-muted-foreground">{LABELS[kicker]}</p>
      <h2 id="next-step-title" className={cn('mt-2', subject ? 'font-serif text-[1.625rem] leading-[2.125rem] font-normal tracking-normal sm:text-[2rem] sm:leading-10' : 'text-2xl leading-8 font-semibold')}>
        {subject ?? headline}
      </h2>
      <p className="mt-2 max-w-2xl text-[0.9375rem] leading-6 text-muted-foreground">{why}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link href={href} className={buttonVariants({ size: 'lg' })}>
          {actionLabel ?? headline}
          <ArrowRight aria-hidden />
        </Link>
        {secondary}
      </div>
      {footer ? <div className="mt-5 border-t pt-5">{footer}</div> : null}
    </section>
  );
}

import { ArrowRight, CircleAlert, Compass, Sparkles } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const KICKERS = {
  attention: { label: 'Needs you', icon: CircleAlert, tone: 'text-warning' },
  continue: { label: 'Pick up where you left off', icon: Compass, tone: 'text-info' },
  start: { label: 'Start here', icon: Sparkles, tone: 'text-primary' },
} as const;

/** The single next action on a screen: what it is, why, and one primary button. */
export function NextStepCard({
  kicker,
  headline,
  why,
  href,
  actionLabel,
  secondary,
  className,
}: {
  kicker: keyof typeof KICKERS;
  headline: string;
  why: string;
  href: string;
  actionLabel?: string;
  secondary?: ReactNode;
  className?: string;
}) {
  const k = KICKERS[kicker];
  const Icon = k.icon;
  return (
    <section aria-labelledby="next-step-title" className={cn('rounded-xl border bg-surface p-5 sm:p-6', className)}>
      <p className={cn('flex items-center gap-1.5 text-sm font-semibold', k.tone)}>
        <Icon aria-hidden className="size-4" />
        {k.label}
      </p>
      <h2 id="next-step-title" className="mt-2 text-xl leading-7 font-semibold sm:text-2xl sm:leading-8">
        {headline}
      </h2>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{why}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link href={href} className={buttonVariants({ size: 'lg' })}>
          {actionLabel ?? headline}
          <ArrowRight aria-hidden />
        </Link>
        {secondary}
      </div>
    </section>
  );
}

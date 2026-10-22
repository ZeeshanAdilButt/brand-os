import { Check } from 'lucide-react';
import type { JourneyStep } from '@/lib/next-step';
import { cn } from '@/lib/utils';

/** The five steps of the path, with where the person is. State comes from the real data, never from a stored flag. */
export function JourneySteps({ steps, className }: { steps: JourneyStep[]; className?: string }) {
  return (
    <ol aria-label="Your progress" className={cn('grid gap-3 sm:grid-cols-5 sm:gap-2', className)}>
      {steps.map((step, i) => (
        <li key={step.id} aria-current={step.state === 'current' ? 'step' : undefined} className="flex gap-3 sm:flex-col sm:gap-2">
          <div className="flex items-center gap-2 sm:w-full">
            <span
              aria-hidden
              className={cn(
                'grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold',
                step.state === 'done' && 'border-success bg-success text-background',
                step.state === 'current' && 'border-primary bg-primary text-primary-foreground',
                step.state === 'todo' && 'border-input bg-surface text-muted-foreground',
              )}
            >
              {step.state === 'done' ? <Check className="size-4" /> : i + 1}
            </span>
            <span aria-hidden className={cn('hidden h-px flex-1 sm:block', i === steps.length - 1 ? 'bg-transparent' : step.state === 'done' ? 'bg-success' : 'bg-border')} />
          </div>
          <div className="min-w-0">
            <p className={cn('text-sm leading-5 font-semibold', step.state === 'todo' && 'text-muted-foreground')}>
              {step.label}
              <span className="sr-only">{step.state === 'done' ? ' (done)' : step.state === 'current' ? ' (current step)' : ' (not yet)'}</span>
            </p>
            <p className="text-xs leading-5 text-muted-foreground">{step.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

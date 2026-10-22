import { Check } from 'lucide-react';
import type { JourneyStep } from '@/lib/next-step';
import { cn } from '@/lib/utils';

/**
 * The five stages of the path and where the person is. State comes from the real data, never from a stored flag.
 * Wide screens show the stage names once with a connector; only the current stage explains itself. Narrow screens
 * show one line, "Step 2 of 5", with the full sequence behind a disclosure.
 */
export function JourneySteps({ steps, className }: { steps: JourneyStep[]; className?: string }) {
  const currentIndex = Math.max(0, steps.findIndex((s) => s.state === 'current'));
  const current = steps[currentIndex];
  const done = steps.filter((s) => s.state === 'done').length;
  return (
    <div className={className}>
      <details className="group sm:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium">
          <span>
            Step {currentIndex + 1} of {steps.length}
            {current ? ` · ${current.label}` : ''}
          </span>
          <span className="text-xs text-muted-foreground">{done} done · All steps</span>
        </summary>
        <ol aria-label="Your progress" className="mt-3 grid gap-3">
          {steps.map((step, i) => (
            <Step key={step.id} step={step} index={i} compact />
          ))}
        </ol>
      </details>
      <ol aria-label="Your progress" className="hidden grid-cols-5 gap-2 sm:grid">
        {steps.map((step, i) => (
          <Step key={step.id} step={step} index={i} last={i === steps.length - 1} />
        ))}
      </ol>
    </div>
  );
}

function Step({ step, index, last = false, compact = false }: { step: JourneyStep; index: number; last?: boolean; compact?: boolean }) {
  const marker = (
    <span
      aria-hidden
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold',
        step.state === 'done' && 'border-success bg-success text-surface',
        step.state === 'current' && 'border-primary bg-primary text-primary-foreground',
        step.state === 'todo' && 'border-input bg-surface text-muted-foreground',
      )}
    >
      {step.state === 'done' ? <Check className="size-3.5" /> : index + 1}
    </span>
  );
  const text = (
    <>
      <p className={cn('text-[0.8125rem] leading-[1.125rem] font-medium', step.state === 'todo' && 'text-muted-foreground', step.state === 'current' && 'font-semibold')}>
        {step.label}
        <span className="sr-only">{step.state === 'done' ? ' (done)' : step.state === 'current' ? ' (current step)' : ' (not yet)'}</span>
      </p>
      {step.state === 'current' ? <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{step.detail}</p> : null}
    </>
  );
  if (compact) {
    return (
      <li aria-current={step.state === 'current' ? 'step' : undefined} className="flex items-start gap-3">
        {marker}
        <div className="min-w-0">{text}</div>
      </li>
    );
  }
  return (
    <li aria-current={step.state === 'current' ? 'step' : undefined} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {marker}
        <span aria-hidden className={cn('h-0.5 flex-1 rounded-full', last ? 'bg-transparent' : step.state === 'done' ? 'bg-success' : 'bg-border')} />
      </div>
      <div className="min-w-0 pr-2">{text}</div>
    </li>
  );
}

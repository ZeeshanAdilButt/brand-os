'use client';

import type { ReactElement } from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

/** Wrap once around the part of the page that uses `Tip`. */
export const TooltipProvider = TooltipPrimitive.Provider;

/**
 * A short label for an icon-only control. It shows on hover and on keyboard focus, is described to screen readers,
 * and goes away with Escape. The control itself must still carry its own accessible name.
 */
export function Tip({ label, side = 'right', children }: { label: string; side?: 'top' | 'right' | 'bottom' | 'left'; children: ReactElement }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={8}
          className="z-[70] max-w-64 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-md"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

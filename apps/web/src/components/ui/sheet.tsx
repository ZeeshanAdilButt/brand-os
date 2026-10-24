'use client';

import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A panel that slides in from the right and fills the height on a phone. Built on the same dialog primitive as the
 * rest of the app (focus is trapped and returned, Escape closes it). Motion is off for people who ask for less.
 */

function Sheet(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="sheet-overlay"
        className="fixed inset-0 z-50 bg-black/45 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0"
      />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col border-l-[1.5px] border-border-strong bg-popover shadow-lg outline-none sm:max-w-xl motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:slide-out-to-right motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:slide-in-from-right motion-safe:duration-200',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function SheetClose({ className }: { className?: string }) {
  return (
    <DialogPrimitive.Close
      data-slot="sheet-close"
      className={cn('grid size-10 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-[120ms] hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring', className)}
    >
      <XIcon aria-hidden className="size-5" />
      <span className="sr-only">Close</span>
    </DialogPrimitive.Close>
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="sheet-title" className={cn('font-display text-xl leading-7 font-semibold tracking-tight', className)} {...props} />;
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="sheet-description" className={cn('text-sm leading-6 text-muted-foreground', className)} {...props} />;
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle };

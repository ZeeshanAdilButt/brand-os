'use client';

import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { AccountInfo } from './account-block';
import { SidebarNav } from './sidebar-nav';

/** Off-canvas navigation for screens below the lg breakpoint. Focus is trapped while open. */
export function MobileNav({
  open,
  onOpenChange,
  account,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: AccountInfo;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 lg:hidden" />
        <DialogPrimitive.Content
          className="fixed inset-y-0 left-0 z-50 w-[min(18rem,85vw)] border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-lg outline-none duration-200 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left lg:hidden"
        >
          <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Primary navigation links</DialogPrimitive.Description>
          <SidebarNav onNavigate={() => onOpenChange(false)} {...(account ? { account } : {})} />
          <DialogPrimitive.Close className="absolute top-3 right-3 grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <X aria-hidden className="size-4" />
            <span className="sr-only">Close navigation</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

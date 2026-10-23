'use client';

import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';

export interface AccountInfo {
  name: string;
  email: string | null;
}

/** Who is signed in, and the sign-out control. Hosted mode only: local mode has no account to leave. */
export function AccountBlock({ account, collapsed = false }: { account: AccountInfo; collapsed?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } finally {
      router.replace('/sign-in');
      router.refresh();
    }
  }

  if (collapsed) {
    return (
      <div className="shrink-0 border-t border-sidebar-border px-2 py-3">
        <Tip label={`Sign out ${account.name}`}>
          <Button type="button" variant="outline" size="icon" className="w-full border-sidebar-muted/50 bg-transparent text-sidebar-foreground hover:bg-sidebar-active hover:text-sidebar-foreground" onClick={signOut} disabled={pending} aria-label={`Sign out ${account.name}`}>
            <LogOut aria-hidden />
          </Button>
        </Tip>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-sidebar-border px-4 py-3">
      <p className="truncate text-sm font-medium text-sidebar-foreground">{account.name}</p>
      {account.email ? <p className="truncate text-xs text-sidebar-muted">{account.email}</p> : null}
      <Button type="button" variant="outline" size="sm" className="mt-3 w-full border-sidebar-muted/50 bg-transparent text-sidebar-foreground hover:bg-sidebar-active hover:text-sidebar-foreground" onClick={signOut} disabled={pending}>
        <LogOut aria-hidden />
        {pending ? 'Signing out' : 'Sign out'}
      </Button>
    </div>
  );
}

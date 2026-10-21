'use client';

import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export interface AccountInfo {
  name: string;
  email: string | null;
}

/** Who is signed in, and the sign-out control. Hosted mode only: local mode has no account to leave. */
export function AccountBlock({ account }: { account: AccountInfo }) {
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

  return (
    <div className="shrink-0 border-t border-sidebar-border px-4 py-3">
      <p className="truncate text-sm font-medium">{account.name}</p>
      {account.email ? <p className="truncate text-xs text-muted-foreground">{account.email}</p> : null}
      <Button type="button" variant="outline" size="sm" className="mt-2.5 w-full" onClick={signOut} disabled={pending}>
        <LogOut aria-hidden />
        {pending ? 'Signing out' : 'Sign out'}
      </Button>
    </div>
  );
}

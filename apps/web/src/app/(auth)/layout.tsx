import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Brand } from '@/components/shell/brand';
import { getAppContext } from '@/server/context';

export const dynamic = 'force-dynamic';

/** Centered card for sign-in and sign-up. Local mode has no sign-in, so these pages send you home. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const ctx = await getAppContext();
  if (ctx.config.mode === 'local') redirect('/');
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-4 py-12">
      <Brand />
      <div className="rounded-xl border bg-card p-6 shadow-soft sm:p-8">{children}</div>
      <p className="text-center text-xs leading-relaxed text-muted-foreground">
        Your account holds only what you add. Nothing is published without your explicit approval.
      </p>
    </main>
  );
}

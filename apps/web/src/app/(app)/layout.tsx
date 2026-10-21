import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { requireSessionUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

/** Every page in the studio sits behind this: hosted mode redirects signed-out visitors to /sign-in. */
export default async function StudioLayout({ children }: { children: ReactNode }) {
  const user = await requireSessionUser();
  // Local mode has no account to show or leave.
  const account = user.ctx.config.mode === 'hosted' ? { name: user.displayName, email: user.email } : undefined;
  return <AppShell {...(account ? { account } : {})}>{children}</AppShell>;
}

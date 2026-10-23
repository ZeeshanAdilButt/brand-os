import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { ViewPrefsProvider } from '@/components/shell/view-prefs';
import { parseViewPrefs, VIEW_COOKIE } from '@/lib/view-prefs';
import { requireSessionUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

/** Every page in the studio sits behind this: hosted mode redirects signed-out visitors to /sign-in. */
export default async function StudioLayout({ children }: { children: ReactNode }) {
  const user = await requireSessionUser();
  // Local mode has no account to show or leave.
  const account = user.ctx.config.mode === 'hosted' ? { name: user.displayName, email: user.email } : undefined;
  // How the person likes the layout (sidebar folded, panels, density) is read here so the first paint is already right.
  const prefs = parseViewPrefs((await cookies()).get(VIEW_COOKIE)?.value);
  return (
    <ViewPrefsProvider initial={prefs}>
      <AppShell {...(account ? { account } : {})}>{children}</AppShell>
    </ViewPrefsProvider>
  );
}

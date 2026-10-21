import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAppContext, type AppContext } from '../context';
import { resolveSessionUser, type SessionUser } from './resolve';

export type { SessionUser };

/** For pages and server actions: the signed-in user, or a redirect to the sign-in page. */
export async function requireSessionUser(): Promise<SessionUser & { ctx: AppContext }> {
  const ctx = await getAppContext();
  const user = await resolveSessionUser(ctx, await headers());
  if (!user) redirect('/sign-in');
  return { ...user, ctx };
}

/** Like requireSessionUser but returns null instead of redirecting (public pages). */
export async function getSessionUser(): Promise<(SessionUser & { ctx: AppContext }) | null> {
  const ctx = await getAppContext();
  const user = await resolveSessionUser(ctx, await headers());
  return user ? { ...user, ctx } : null;
}

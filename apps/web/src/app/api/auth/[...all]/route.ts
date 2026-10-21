import { NextResponse } from 'next/server';
import { getAppContext } from '@/server/context';

export const dynamic = 'force-dynamic';

/** Hosted-mode sign-in endpoints (Better Auth). Local mode has no sign-in, so there is nothing to serve. */
async function handle(request: Request): Promise<Response> {
  const ctx = await getAppContext();
  if (!ctx.auth) return NextResponse.json({ error: 'Sign-in is not used in local mode.' }, { status: 404 });
  return ctx.auth.handler(request);
}

export { handle as GET, handle as POST };

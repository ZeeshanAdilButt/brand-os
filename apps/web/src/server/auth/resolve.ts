import type { AppContext } from '../context';
import { ensureLocalOwner, findUser } from '../data/users';

/**
 * The authenticated person behind a request. `userId` is the only source of the tenant id for every
 * data access: it comes from the session (hosted) or the single local owner (local), never from
 * request input, a form field, an MCP argument or an AI tool call.
 */
export interface SessionUser {
  userId: string;
  displayName: string;
  email: string | null;
  kind: 'local_owner' | 'member';
  isOwner: boolean;
  /** The browser session this request belongs to: 'local' in local mode. */
  sessionId: string;
}

/** Resolve the session for a request's headers. Null means signed out (hosted only). */
export async function resolveSessionUser(ctx: AppContext, requestHeaders: Headers): Promise<SessionUser | null> {
  if (ctx.config.mode === 'local') {
    return toSessionUser(await ensureLocalOwner(ctx.db), 'local');
  }
  if (!ctx.auth) return null;
  const session = await ctx.auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const user = await findUser(ctx.db, session.user.id);
  return user ? toSessionUser(user, session.session.id) : null;
}

function toSessionUser(
  user: {
    id: string;
    displayName: string;
    email: string | null;
    kind: 'local_owner' | 'member';
    isOwner: boolean;
  },
  sessionId: string,
): SessionUser {
  return { userId: user.id, displayName: user.displayName, email: user.email, kind: user.kind, isOwner: user.isOwner, sessionId };
}

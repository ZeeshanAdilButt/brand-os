import type { AgentScope } from '../../lib/agent';
import { ActionError, sessionToOwner, type OwnerContext } from '../actions/owner';
import { defaultLimiters, type AgentLimiters } from '../agent/rate-limit';
import { bearerFrom, hashSecret, looksLikeSecret } from '../agent/secret';
import { getAppContext, type AppContext } from '../context';
import { findCredentialBySecretHash } from '../data/tenant';
import { actionErrorResponse, json, type HandlerDeps } from './handlers';
import { checkRequest } from './guard';

/** Deps for the agent API: the usual seams plus the rate limiters, which tests replace. */
export interface AgentHandlerDeps extends HandlerDeps {
  limiters?: AgentLimiters;
}

/** Who is calling: facts about the credential, never an owner id a caller could pass in. */
export interface AgentIdentity {
  credentialId: string;
  name: string;
  scopes: AgentScope[];
}

const globalForLimiters = globalThis as typeof globalThis & { __cphAgentLimiters?: AgentLimiters };

function limitersFor(deps: AgentHandlerDeps): AgentLimiters {
  if (deps.limiters) return deps.limiters;
  globalForLimiters.__cphAgentLimiters ??= defaultLimiters();
  return globalForLimiters.__cphAgentLimiters;
}

function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || 'direct';
}

const NOT_VALID = 'This credential is missing, not valid or has been revoked.';

/**
 * Wrap an agent API handler. The credential in the Authorization header is the ONLY thing that
 * decides whose data a request touches: the owner id comes from the credential row, never from the
 * path, query or body. Order of checks: host guard, credential shape, lookup, revocation, rate limit,
 * scope, then the handler. Every change an agent makes is recorded in the owner's audit log.
 */
export async function withAgent(
  request: Request,
  deps: AgentHandlerDeps,
  options: { scope: AgentScope; action: string },
  run: (owner: OwnerContext, agent: AgentIdentity, ctx: AppContext) => Promise<Response>,
): Promise<Response> {
  const ctx = deps.ctx ?? (await getAppContext());
  const guard = checkRequest(request, ctx.config);
  if (!guard.ok) return json({ error: guard.reason }, guard.status);

  const limiters = limitersFor(deps);
  const deny = (): Response => {
    const tried = limiters.failures.take(clientKey(request));
    if (!tried.ok) return json({ error: 'Too many failed attempts. Wait a moment.' }, 429, { 'Retry-After': String(tried.retryAfterSec) });
    return json({ error: NOT_VALID }, 401, { 'WWW-Authenticate': 'Bearer' });
  };

  const presented = bearerFrom(request.headers);
  if (!presented || !looksLikeSecret(presented)) return deny();
  const found = await findCredentialBySecretHash(ctx.db, hashSecret(presented));
  if (!found) return deny();

  const owner = sessionToOwner({ userId: found.ownerId }, ctx, 'agent');
  const data = owner.data;
  if (found.revokedAt) {
    await data.audit.record({ actor: 'agent', action: 'agent.denied_revoked', entityType: 'agent_credential', entityId: found.id });
    return deny();
  }

  const used = limiters.perCredential.take(found.id);
  if (!used.ok) {
    return json({ error: 'Too many requests for this credential. Slow down.', code: 'limit' }, 429, { 'Retry-After': String(used.retryAfterSec) });
  }
  if (!found.scopes.includes(options.scope)) {
    return json({ error: `This credential does not have the "${options.scope}" scope.`, code: 'forbidden' }, 403);
  }
  await data.credentials.touch(found.id);

  const agent: AgentIdentity = { credentialId: found.id, name: found.name, scopes: found.scopes };
  let response: Response;
  try {
    response = await run(owner, agent, ctx);
  } catch (err) {
    if (err instanceof ActionError) response = actionErrorResponse(err);
    else {
      console.error('agent api handler failed', err instanceof Error ? err.name : 'unknown error');
      response = json({ error: 'Something went wrong.' }, 500);
    }
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      await data.audit.record({
        actor: 'agent',
        action: options.action,
        entityType: 'agent_credential',
        entityId: found.id,
        metadata: { status: response.status },
      });
    } catch {
      // The audit write must not turn a finished request into a failure.
    }
  }
  return response;
}

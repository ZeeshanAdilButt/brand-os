import { getProfile } from '../actions/profile';
import { withAgent, type AgentHandlerDeps } from './agent-auth';
import { json } from './handlers';

/**
 * The agent API (/api/agent/*). Every handler goes through withAgent, so the credential alone chooses
 * the owner, and calls the same actions the UI calls. No handler here reads an owner id from the
 * request, and none takes publishing, platform drafts or approvals (those arrive on later days).
 */

/** Who this credential is and what it can see: profile, brand preferences and the credential's own scopes. */
export function handleAgentMe(request: Request, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'read', action: 'agent.me' }, async (owner, agent) => {
    const { profile, preferences } = await getProfile(owner);
    return json({ credential: { name: agent.name, scopes: agent.scopes }, profile, preferences });
  });
}

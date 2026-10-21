import { createCredential, listCredentials, revokeCredential } from '../actions/agent-credentials';
import { json, readJson, withOwner, type HandlerDeps } from './handlers';

/** Settings > Agent access. Session only: an agent credential cannot manage credentials. */
export function handleCredentialsGet(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json({ credentials: await listCredentials(owner) }));
}

/** The secret is in this response and nowhere else, ever again. */
export function handleCredentialCreate(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await createCredential(owner, await readJson(request)), 201));
}

export function handleCredentialRevoke(request: Request, id: string, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await revokeCredential(owner, id)));
}

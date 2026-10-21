import {
  approveAndPublish,
  checkOnPlatform,
  connectPlatform,
  declineApproval,
  disconnectPlatform,
  getDraft,
  listConnections,
  listDestinations,
  listDrafts,
  markByHand,
  prepareDraft,
  requestApproval,
  selectPublication,
  stageDraft,
  testConnection,
} from '../actions/publishing';
import { ActionError } from '../actions/owner';
import type { AppConfig } from '../config';
import { publishEnvFrom, type PublishEnv } from '../publishing/registry';
import { json, readJson, withOwner, type HandlerDeps } from './handlers';

/** Deps for the publishing routes: the usual seams plus overrides for the network, clock and retry pause. */
export interface PublishHandlerDeps extends HandlerDeps {
  publish?: Partial<Omit<PublishEnv, 'config'>>;
}

/**
 * Approving is a person's act in the app. Besides the signed-in session every route already needs, these
 * routes refuse any request that carries an Authorization header (an agent credential or anything like it)
 * and any request that does not say which page it came from. A browser always sends Origin on a POST and
 * the request guard has already checked that it names this app; a script that only holds a credential
 * does neither.
 */
export function requireBrowserOrigin(request: Request): void {
  if (request.headers.get('authorization')) {
    throw new ActionError('forbidden', 'This cannot be done with an agent credential. Approve in the app, signed in as yourself.');
  }
  const origin = request.headers.get('origin');
  if (!origin) throw new ActionError('forbidden', 'This must be done from the app in your browser.');
}

const envFor = (deps: PublishHandlerDeps, ctx: { config: AppConfig }) => publishEnvFrom(ctx, deps.publish);

// ---- connections -------------------------------------------------------------------------------------

export function handleConnectionsGet(request: Request, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json({ connections: await listConnections(owner) }));
}

export function handleConnectionCreate(request: Request, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await connectPlatform(owner, envFor(deps, ctx), await readJson(request)), 201));
}

export function handleConnectionTest(request: Request, id: string, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await testConnection(owner, envFor(deps, ctx), id)));
}

export function handleConnectionPatch(request: Request, id: string, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await selectPublication(owner, id, await readJson(request))));
}

export function handleConnectionDelete(request: Request, id: string, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    await disconnectPlatform(owner, id);
    return json({ deleted: true });
  });
}

// ---- drafts ------------------------------------------------------------------------------------------

export function handleDestinationsGet(request: Request, articleId: string, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json({ destinations: await listDestinations(owner, envFor(deps, ctx), articleId) }));
}

export function handleDraftsGet(request: Request, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    return json({ drafts: await listDrafts(owner, envFor(deps, ctx), params) });
  });
}

export function handleDraftCreate(request: Request, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await prepareDraft(owner, envFor(deps, ctx), await readJson(request)), 201));
}

export function handleDraftGet(request: Request, id: string, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await getDraft(owner, envFor(deps, ctx), id)));
}

export function handleDraftStage(request: Request, id: string, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await stageDraft(owner, envFor(deps, ctx), id)));
}

export function handleDraftRequestApproval(request: Request, id: string, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await requestApproval(owner, envFor(deps, ctx), id), 201));
}

export function handleDraftCheck(request: Request, id: string, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await checkOnPlatform(owner, envFor(deps, ctx), id)));
}

export function handleDraftMark(request: Request, id: string, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    requireBrowserOrigin(request);
    return json(await markByHand(owner, envFor(deps, ctx), id, await readJson(request)));
  });
}

// ---- approvals ---------------------------------------------------------------------------------------

export function handleApprovalApprove(request: Request, id: string, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    requireBrowserOrigin(request);
    return json(await approveAndPublish(owner, envFor(deps, ctx), id, await readJson(request)));
  });
}

export function handleApprovalDecline(request: Request, id: string, deps: PublishHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    requireBrowserOrigin(request);
    return json(await declineApproval(owner, envFor(deps, ctx), id));
  });
}

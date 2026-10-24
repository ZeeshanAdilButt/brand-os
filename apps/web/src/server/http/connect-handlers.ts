import { cancelDevice, completeOAuth, connectWithFields, disconnectConnector, listConnectors, pollDeviceFlow, startDevice, startOAuth, testConnector } from '../actions/connect';
import { ActionError } from '../actions/owner';
import { resolveSessionUser } from '../auth/resolve';
import { sessionToOwner } from '../actions/owner';
import type { ConnectEnv } from '../connect/env';
import { getAppContext } from '../context';
import { checkRequest } from './guard';
import { json, readJson, withOwner, type HandlerDeps } from './handlers';

/** Deps for the connection routes: the usual seams plus overrides for the network, the clock, the limits and randomness. */
export interface ConnectHandlerDeps extends HandlerDeps {
  connect?: Partial<Omit<ConnectEnv, 'config'>>;
}

/**
 * Connecting, testing and disconnecting are a person's acts in the app. Besides the signed-in session every route
 * already needs, these routes refuse any request that carries an Authorization header (an agent credential or anything
 * like it), and the ones that change something also refuse a request that does not say which page it came from. A
 * browser always sends Origin on a POST or DELETE and the request guard has already checked that it names this app; a
 * script that only holds a credential does neither.
 */
function refuseCredential(request: Request): void {
  if (request.headers.get('authorization')) {
    throw new ActionError('forbidden', 'This cannot be done with an agent credential. Connect in the app, signed in as yourself.');
  }
}

function requireBrowser(request: Request): void {
  refuseCredential(request);
  if (!request.headers.get('origin')) throw new ActionError('forbidden', 'This must be done from the app in your browser.');
}

const envOf = (deps: ConnectHandlerDeps, ctx: { config: ConnectEnv['config'] }): ConnectEnv => ({ config: ctx.config, ...deps.connect });

export function handleConnectorsGet(request: Request, deps: ConnectHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    refuseCredential(request);
    return json({ connectors: await listConnectors(owner, envOf(deps, ctx)) });
  });
}

export function handleConnectFields(request: Request, platform: string, deps: ConnectHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    requireBrowser(request);
    return json(await connectWithFields(owner, envOf(deps, ctx), platform, await readJson(request)));
  });
}

export function handleConnectStart(request: Request, platform: string, deps: ConnectHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    requireBrowser(request);
    return json(await startOAuth(owner, envOf(deps, ctx), platform, await readJson(request).catch(() => ({}))));
  });
}

export function handleConnectDeviceStart(request: Request, platform: string, deps: ConnectHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    requireBrowser(request);
    return json(await startDevice(owner, envOf(deps, ctx), platform, await readJson(request).catch(() => ({}))));
  });
}

export function handleConnectDevicePoll(request: Request, platform: string, deps: ConnectHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    requireBrowser(request);
    const body = (await readJson(request)) as { flowId?: unknown } | null;
    return json(await pollDeviceFlow(owner, envOf(deps, ctx), platform, body?.flowId));
  });
}

export function handleConnectDeviceCancel(request: Request, platform: string, deps: ConnectHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    requireBrowser(request);
    return json(await cancelDevice(owner, envOf(deps, ctx), platform));
  });
}

export function handleConnectTest(request: Request, platform: string, deps: ConnectHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    requireBrowser(request);
    return json(await testConnector(owner, envOf(deps, ctx), platform));
  });
}

export function handleConnectDisconnect(request: Request, platform: string, deps: ConnectHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    requireBrowser(request);
    return json(await disconnectConnector(owner, envOf(deps, ctx), platform));
  });
}

const back = (platform: string | null, code: string): Response =>
  new Response(null, { status: 303, headers: { location: `/platforms/integrations?${platform ? `connect=${encodeURIComponent(platform)}&` : ''}result=${encodeURIComponent(code)}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });

/**
 * Where the platform sends the person back to. It is a GET navigation from another site, so it has no Origin to check;
 * what protects it is the state: random, stored only as a hash, bound to the session that started the sign-in, used
 * once and short lived. It answers with a redirect to the Integrations screen carrying a short result code and nothing
 * else: no code, no token and no message from the platform ever reaches a URL.
 */
export async function handleConnectCallback(request: Request, platform: string, deps: ConnectHandlerDeps = {}): Promise<Response> {
  const ctx = deps.ctx ?? (await getAppContext());
  const guard = checkRequest(request, ctx.config);
  if (!guard.ok) return back(null, 'error');
  if (request.headers.get('authorization')) return back(null, 'error');
  const user = await resolveSessionUser(ctx, request.headers);
  if (!user) return new Response(null, { status: 303, headers: { location: '/sign-in', 'cache-control': 'no-store' } });
  try {
    const query = new URL(request.url).searchParams;
    const result = await completeOAuth(sessionToOwner(user, ctx), envOf(deps, ctx), platform, { code: query.get('code'), state: query.get('state'), error: query.get('error') });
    return back(result.platform, result.code);
  } catch {
    return back(null, 'error');
  }
}

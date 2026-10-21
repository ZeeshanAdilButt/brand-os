import { aiAvailability, createProvider, deleteProvider, listProviders, setDefaultProvider, testProvider, updateProvider } from '../actions/ai-providers';
import { aiEnvFrom, type AiEnv } from '../ai/runtime';
import { json, readJson, withOwner, type HandlerDeps } from './handlers';

/** Deps for the AI routes: the usual seams plus overrides for the network, name lookup, clock and sleeps. */
export interface AiHandlerDeps extends HandlerDeps {
  ai?: Partial<Omit<AiEnv, 'config'>>;
}

/** Providers and whether AI is available at all (the editor reads this to enable or disable its actions). */
export function handleProvidersGet(request: Request, deps: AiHandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    const [providers, availability] = await Promise.all([listProviders(owner), aiAvailability(owner)]);
    return json({ providers, available: availability.available });
  });
}

export function handleProviderCreate(request: Request, deps: AiHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await createProvider(owner, aiEnvFrom(ctx, deps.ai), await readJson(request)), 201));
}

export function handleProviderPatch(request: Request, id: string, deps: AiHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await updateProvider(owner, aiEnvFrom(ctx, deps.ai), id, await readJson(request))));
}

export function handleProviderDelete(request: Request, id: string, deps: AiHandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    await deleteProvider(owner, id);
    return json({ deleted: true });
  });
}

export function handleProviderDefault(request: Request, id: string, deps: AiHandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await setDefaultProvider(owner, id)));
}

export function handleProviderTest(request: Request, id: string, deps: AiHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await testProvider(owner, aiEnvFrom(ctx, deps.ai), id)));
}

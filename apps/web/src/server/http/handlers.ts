import { NextResponse } from 'next/server';
import { ActionError, sessionToOwner, type OwnerContext } from '../actions/owner';
import { exportMyData } from '../actions/export';
import {
  createItem,
  createSource,
  deleteItem,
  deleteSource,
  getItem,
  listItems,
  listSources,
  markReviewed,
  updateItem,
} from '../actions/knowledge';
import { getProfile, preferencesInputSchema, profileInputSchema, savePreferences, saveProfile } from '../actions/profile';
import { parseInput } from '../actions/owner';
import { resolveSessionUser } from '../auth/resolve';
import { getAppContext, type AppContext } from '../context';
import { checkRequest } from './guard';

/** Optional override of the server context; tests pass one. Production leaves it out. */
export interface HandlerDeps {
  ctx?: AppContext;
}

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: unknown, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ActionError('invalid', 'The request body must be valid JSON.');
  }
}

/**
 * Wrap a handler: guard the request, resolve the session, build the owner context from that
 * session (the only source of the tenant id), run, and turn failures into safe JSON. The request
 * body, query string and path are inputs to the action and can never choose whose data is touched.
 */
async function withOwner(
  request: Request,
  deps: HandlerDeps,
  run: (owner: OwnerContext, ctx: AppContext) => Promise<Response>,
): Promise<Response> {
  const ctx = deps.ctx ?? (await getAppContext());
  const guard = checkRequest(request, ctx.config);
  if (!guard.ok) return json({ error: guard.reason }, guard.status);
  const user = await resolveSessionUser(ctx, request.headers);
  if (!user) return json({ error: 'Sign in required.' }, 401);
  try {
    return await run(sessionToOwner(user, ctx), ctx);
  } catch (err) {
    if (err instanceof ActionError) {
      return json({ error: err.message, fields: err.fields }, err.code === 'not_found' ? 404 : 400);
    }
    console.error('api handler failed', err instanceof Error ? err.name : 'unknown error');
    return json({ error: 'Something went wrong.' }, 500);
  }
}

export function handleExport(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    const data = await exportMyData(owner);
    return json(data, 200, { 'Content-Disposition': 'attachment; filename="brand-os-export.json"' });
  });
}

export function handleProfileGet(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await getProfile(owner)));
}

export function handleProfilePut(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    const body = (await readJson(request)) as { profile?: unknown; preferences?: unknown } | null;
    if (!body || typeof body !== 'object') throw new ActionError('invalid', 'Send { profile?, preferences? }.');
    // Validate everything first so a bad preferences block cannot leave a half-saved profile.
    if (body.profile !== undefined) parseInput(profileInputSchema, body.profile);
    if (body.preferences !== undefined) parseInput(preferencesInputSchema, body.preferences);
    if (body.profile !== undefined) await saveProfile(owner, body.profile);
    if (body.preferences !== undefined) await savePreferences(owner, body.preferences);
    return json(await getProfile(owner));
  });
}

export function handleItemsGet(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const { q, kind, confidentiality, status, limit, offset } = params;
    const result = await listItems(owner, { q, kind, confidentiality, verificationStatus: status, limit, offset });
    return json({
      query: result.query,
      items: result.items,
      ...(result.hits ? { hits: result.hits.map((h) => ({ id: h.item.id, rank: h.rank, snippet: h.snippet, title: h.titleMarked })) } : {}),
    });
  });
}

export function handleItemCreate(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await createItem(owner, await readJson(request)), 201));
}

export function handleItemGet(request: Request, id: string, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await getItem(owner, id)));
}

export function handleItemPatch(request: Request, id: string, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await updateItem(owner, id, await readJson(request))));
}

export function handleItemDelete(request: Request, id: string, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    await deleteItem(owner, id);
    return json({ deleted: true });
  });
}

export function handleItemReview(request: Request, id: string, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await markReviewed(owner, id)));
}

export function handleSourcesGet(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json({ sources: await listSources(owner) }));
}

export function handleSourceCreate(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await createSource(owner, await readJson(request)), 201));
}

export function handleSourceDelete(request: Request, id: string, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    await deleteSource(owner, id);
    return json({ deleted: true });
  });
}

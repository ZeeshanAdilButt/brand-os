import { createArticle, getArticle, listArticles, saveArticle } from '../actions/articles';
import { agentListTasks, agentTaskView, submitTaskResult } from '../actions/ai-tasks';
import { listItems } from '../actions/knowledge';
import { ActionError } from '../actions/owner';
import { editDraft, getPreview } from '../actions/composer';
import { getDraft, listDestinations, listDrafts, prepareDraft, requestApproval, stageDraft } from '../actions/publishing';
import { publishEnvFrom } from '../publishing/registry';
import { getProfile } from '../actions/profile';
import { articleRowView, articleView, destinationView, itemView, platformDraftStatusView, platformDraftView, preferencesView, profileView } from '../agent/views';
import { aiEnvFrom } from '../ai/runtime';
import { withAgent, type AgentHandlerDeps } from './agent-auth';
import { json, readJson } from './handlers';
import { MARK_END, MARK_START } from '../../lib/knowledge';

/**
 * The agent API (/api/agent/*). Every handler goes through withAgent, so the key alone chooses the
 * owner, and calls the same actions the UI calls: validation, concurrency and audit are identical.
 * No handler reads an owner id from the request. Platform drafts can be prepared, staged privately and put
 * up for approval here, and that is all: there is deliberately no route that approves, declines, publishes,
 * checks, marks or connects anything. Those are the signed-in owner's acts in the app.
 */

/** Replacing the owner's edits with a fresh adaptation is the owner's choice, so an agent cannot ask for it. */
function withoutDiscard(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const { discardEdits: _discard, ...rest } = body as Record<string, unknown>;
  void _discard;
  return rest;
}

/** Strip the search highlight markers: an agent wants plain text. */
const plain = (s: string) => s.split(MARK_START).join('').split(MARK_END).join('');

/** Who this key is and what it can see: profile, brand preferences and the key's own scopes. */
export function handleAgentMe(request: Request, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'read', action: 'agent.me' }, async (owner, agent) => {
    const { profile, preferences } = await getProfile(owner);
    return json({ credential: { name: agent.name, scopes: agent.scopes }, profile: profileView(profile), preferences: preferencesView(preferences) });
  });
}

/** Search the owner's knowledge items (ranked, with snippets) or list the latest. */
export function handleAgentKnowledge(request: Request, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'read', action: 'agent.knowledge.search' }, async (owner) => {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const { q, kind, limit, offset } = params;
    const result = await listItems(owner, { q, kind, limit: limit ?? '20', offset });
    const snippets = new Map((result.hits ?? []).map((h) => [h.item.id, plain(h.snippet)]));
    return json({ query: result.query, items: result.items.map((item) => itemView(item, snippets.get(item.id))) });
  });
}

export function handleAgentArticlesGet(request: Request, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'read', action: 'agent.articles.list' }, async (owner) => {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const result = await listArticles(owner, params);
    const snippets = new Map((result.hits ?? []).map((h) => [h.article.id, plain(h.snippet)]));
    return json({ query: result.query, articles: result.articles.map((a) => articleRowView(a, snippets.get(a.id))) });
  });
}

export function handleAgentArticleGet(request: Request, id: string, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'read', action: 'agent.articles.get' }, async (owner) => json(articleView(await getArticle(owner, id))));
}

export function handleAgentArticleCreate(request: Request, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'write_articles', action: 'agent.articles.create' }, async (owner) =>
    json(articleView(await createArticle(owner, await readJson(request))), 201),
  );
}

/** Save changes. The body must name `expectedRevision`; a stale one is answered with 409 and the current copy. */
export function handleAgentArticlePatch(request: Request, id: string, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'write_articles', action: 'agent.articles.update' }, async (owner) => {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ActionError('invalid', 'Send a JSON object with expectedRevision and the fields to change.');
    // An agent cannot choose why a save happened (the action records it as the agent's) or which cover image to use.
    const { reason: _reason, coverAssetId: _cover, ...allowed } = body as Record<string, unknown>;
    void _reason;
    void _cover;
    try {
      return json(articleView(await saveArticle(owner, id, allowed)));
    } catch (err) {
      // The current copy in a conflict answer goes through the same view as every other article.
      if (err instanceof ActionError && err.code === 'conflict' && err.data && typeof err.data === 'object' && 'current' in err.data) {
        const current = (err.data as { current: Parameters<typeof articleView>[0] }).current;
        throw new ActionError('conflict', err.message, err.fields, { current: articleView(current) });
      }
      throw err;
    }
  });
}

/** AI tasks waiting for the owner's own Claude Code (pending or running by default). Scope: read. */
export function handleAgentTasksGet(request: Request, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'read', action: 'agent.ai_tasks.list' }, async (owner, _agent, ctx) => {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    return json({ tasks: await agentListTasks(owner, { env: aiEnvFrom(ctx, deps.ai) }, params) });
  });
}

/** One task with everything needed to complete it. Scope: read. */
export function handleAgentTaskGet(request: Request, id: string, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'read', action: 'agent.ai_tasks.get' }, async (owner) => json(await agentTaskView(owner, id)));
}

/** Submit the operations that complete a task. They are validated like a model's answer and wait for the owner's review. Scope: ai_tasks. */
export function handleAgentTaskResult(request: Request, id: string, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'ai_tasks', action: 'agent.ai_tasks.submit_result' }, async (owner) => {
    const task = await submitTaskResult(owner, id, await readJson(request));
    return json({ id: task.id, status: task.status });
  });
}

/* ---------- platform drafts: prepare, stage privately, ask. Never approve or publish. ---------- */

export function handleAgentDraftsGet(request: Request, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'read', action: 'agent.platform_drafts.list' }, async (owner, _agent, ctx) => {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const drafts = await listDrafts(owner, publishEnvFrom(ctx, deps.publish), params);
    return json({ drafts: drafts.map(platformDraftStatusView) });
  });
}

export function handleAgentDraftGet(request: Request, id: string, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'read', action: 'agent.platform_drafts.get' }, async (owner, _agent, ctx) =>
    json(platformDraftView(await getDraft(owner, publishEnvFrom(ctx, deps.publish), id))),
  );
}

/** Where a draft stands: the status, the link once published, any failure and the approval, if one is open. */
/** The destinations of an article: which exist, which the app can send to, and where each draft stands. Scope: read. */
export function handleAgentDestinations(request: Request, articleId: string, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'read', action: 'agent.destinations.list' }, async (owner, _agent, ctx) => {
    const all = await listDestinations(owner, publishEnvFrom(ctx, deps.publish), articleId);
    return json({ destinations: all.map(destinationView) });
  });
}

/** Change a destination's text or metadata. It is a new payload hash and voids any approval; nothing is sent. Scope: platform_drafts. */
export function handleAgentDraftUpdate(request: Request, id: string, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'platform_drafts', action: 'agent.platform_drafts.update' }, async (owner, _agent, ctx) => {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ActionError('invalid', 'Send a JSON object with expectedHash and the fields to change.');
    // An agent edits the text and metadata. The personal site's file options (replace an existing file) are the owner's choice.
    const { site: _site, ...allowed } = body as Record<string, unknown>;
    void _site;
    const result = await editDraft(owner, publishEnvFrom(ctx, deps.publish), id, allowed);
    return json({ changed: result.changed, fields: result.fields, voidedApproval: result.voidedApproval, message: result.message, draft: platformDraftView(result.draft) });
  });
}

/** The exact payload, the checks and an approximate preview as text. Scope: read. */
export function handleAgentDraftPreview(request: Request, id: string, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'read', action: 'agent.platform_drafts.preview' }, async (owner, _agent, ctx) =>
    json(await getPreview(owner, publishEnvFrom(ctx, deps.publish), id)),
  );
}

export function handleAgentDraftStatus(request: Request, id: string, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'read', action: 'agent.platform_drafts.status' }, async (owner, _agent, ctx) =>
    json(platformDraftStatusView(await getDraft(owner, publishEnvFrom(ctx, deps.publish), id))),
  );
}

export function handleAgentDraftCreate(request: Request, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'platform_drafts', action: 'agent.platform_drafts.create' }, async (owner, _agent, ctx) =>
    json(platformDraftView(await prepareDraft(owner, publishEnvFrom(ctx, deps.publish), withoutDiscard(await readJson(request)))), 201),
  );
}

/** Creates or updates the PRIVATE copy on the platform. It cannot publish and refuses to touch a live post. */
export function handleAgentDraftStage(request: Request, id: string, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'platform_drafts', action: 'agent.platform_drafts.stage' }, async (owner, _agent, ctx) => {
    const result = await stageDraft(owner, publishEnvFrom(ctx, deps.publish), id);
    return json({ ok: result.ok, message: result.message, draft: platformDraftView(result.draft) });
  });
}

/** Opens a pending approval and returns the link where the owner decides. Opening the link approves nothing. */
export function handleAgentDraftRequestApproval(request: Request, id: string, deps: AgentHandlerDeps = {}) {
  return withAgent(request, deps, { scope: 'platform_drafts', action: 'agent.platform_drafts.request_approval' }, async (owner, _agent, ctx) => {
    const result = await requestApproval(owner, publishEnvFrom(ctx, deps.publish), id);
    return json(
      {
        status: result.draft.status,
        approval: result.draft.approval ? { status: result.draft.approval.status, tag: result.draft.approval.tag, expiresAt: result.draft.approval.expiresAt } : null,
        link: result.link,
        note: 'Only the owner can approve, by opening the link in the app and signing in. Poll get_publication_status to see the outcome.',
      },
      201,
    );
  });
}

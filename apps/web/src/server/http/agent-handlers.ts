import { createArticle, getArticle, listArticles, saveArticle } from '../actions/articles';
import { agentListTasks, agentTaskView, submitTaskResult } from '../actions/ai-tasks';
import { listItems } from '../actions/knowledge';
import { ActionError } from '../actions/owner';
import { getProfile } from '../actions/profile';
import { articleRowView, articleView, itemView, preferencesView, profileView } from '../agent/views';
import { aiEnvFrom } from '../ai/runtime';
import { withAgent, type AgentHandlerDeps } from './agent-auth';
import { json, readJson } from './handlers';
import { MARK_END, MARK_START } from '../../lib/knowledge';

/**
 * The agent API (/api/agent/*). Every handler goes through withAgent, so the key alone chooses the
 * owner, and calls the same actions the UI calls: validation, concurrency and audit are identical.
 * No handler reads an owner id from the request. There are deliberately no publishing, platform
 * draft or approval routes here; those arrive on later days and stay behind the approval gate.
 */

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

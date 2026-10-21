import { after } from 'next/server';
import { aiAvailability, createProvider, deleteProvider, listProviders, setDefaultProvider, testProvider, updateProvider } from '../actions/ai-providers';
import { runTask } from '../actions/ai-run';
import { acceptTask, createTask, getTask, listTasks, previewTaskContext, rejectTask, retryTask, type TaskDeps } from '../actions/ai-tasks';
import { subscribeTaskEvents } from '../ai/events';
import { aiEnvFrom, type AiEnv } from '../ai/runtime';
import type { AppContext } from '../context';
import { json, readJson, withOwner, type HandlerDeps } from './handlers';

/** Deps for the AI routes: the usual seams plus overrides for the network, name lookup, clock and sleeps. */
export interface AiHandlerDeps extends HandlerDeps {
  ai?: Partial<Omit<AiEnv, 'config'>>;
  /** Where background work goes. Production uses Next's `after`; tests collect the jobs to await them. */
  schedule?: (job: () => Promise<void>) => void;
}

/** Run a job after the response is sent. Outside a request (a script, a test) it simply starts it. */
export function defaultSchedule(job: () => Promise<void>): void {
  const guarded = () => job().catch((err: unknown) => console.error('background task failed', err instanceof Error ? err.name : 'unknown error'));
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}

export function taskDepsFor(deps: AiHandlerDeps, ctx: AppContext): TaskDeps {
  const env = aiEnvFrom(ctx, deps.ai);
  return { env, schedule: deps.schedule ?? defaultSchedule, start: (owner, taskId) => runTask(owner, env, taskId) };
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

/* ---------- tasks ---------- */

/** What would be sent for a task, exactly, so private items can be approved by reading it. Creates nothing. */
export function handleContextPreview(request: Request, deps: AiHandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await previewTaskContext(owner, await readJson(request))));
}

export function handleTaskCreate(request: Request, deps: AiHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await createTask(owner, taskDepsFor(deps, ctx), await readJson(request)), 201));
}

export function handleTasksGet(request: Request, deps: AiHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    return json({ tasks: await listTasks(owner, taskDepsFor(deps, ctx), params) });
  });
}

export function handleTaskGet(request: Request, id: string, deps: AiHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await getTask(owner, taskDepsFor(deps, ctx), id)));
}

export function handleTaskAccept(request: Request, id: string, deps: AiHandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await acceptTask(owner, id, await readJson(request))));
}

export function handleTaskReject(request: Request, id: string, deps: AiHandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await rejectTask(owner, id)));
}

export function handleTaskRetry(request: Request, id: string, deps: AiHandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await retryTask(owner, taskDepsFor(deps, ctx), id)));
}

/**
 * Server-sent events: one `task` event whenever one of THIS owner's tasks changes, sent right after the
 * change is committed. The stream is tied to the session, so another user's events never arrive. A comment
 * line every 25 seconds keeps proxies from closing it; the browser reconnects by itself if it drops.
 */
export function handleEvents(request: Request, deps: AiHandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            cleanup();
          }
        };
        const unsubscribe = subscribeTaskEvents(owner.ownerId, (event) => write(`event: task\ndata: ${JSON.stringify(event)}\n\n`));
        const heartbeat = setInterval(() => write(': keep-alive\n\n'), 25_000);
        cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        request.signal.addEventListener('abort', cleanup, { once: true });
        write('retry: 3000\n\nevent: ready\ndata: {}\n\n');
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' },
    });
  });
}

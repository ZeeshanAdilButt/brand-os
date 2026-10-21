import { ResultRejected } from '../../lib/ai-ops';
import { AdapterError } from '../ai/adapters/types';
import { registerActive, releaseActive } from '../ai/active';
import { originalsInsideExcerpt } from '../ai/apply';
import { estimateTokens } from '../ai/context';
import { parseModelResult } from '../ai/output';
import { redactSecrets } from '../ai/redact';
import { adapterFor, DEFAULT_TASK_TIMEOUT_MS, executesTasks, plainKey, type AiEnv } from '../ai/runtime';
import type { AiTask } from '../db/schema';
import { announce, ensureUnderCap } from './ai-tasks';
import { ActionError, type OwnerContext } from './owner';

/**
 * Runs one task on its provider, in the background. The model's answer goes through the same validation as
 * a result from Claude Code, and the task ends in "ready to review" or "failed". It never applies anything.
 *
 *  - bounded: one call may take at most `env.taskTimeoutMs` (two minutes by default);
 *  - cancellable: cancelling the task aborts the call in flight;
 *  - one retry, only for failures that are the provider's or the connection's (overloaded, 5xx, a short
 *    rate limit, a dropped connection), never for a refused request or a bad answer;
 *  - cached: an identical request answered earlier is reused at no cost;
 *  - capped: a provider's monthly soft cap stops the run with a message.
 */
export async function runTask(owner: OwnerContext, env: AiEnv, taskId: string): Promise<void> {
  const actor: OwnerContext = { ...owner, actor: 'ai' };
  const claimed = await actor.data.tasks.transition(taskId, ['pending'], { status: 'running', attempts: 0 });
  if (!claimed) return; // already running, cancelled, or not this owner's
  await announce(actor, claimed);

  const controller = new AbortController();
  registerActive(taskId, controller);
  let secret: string | undefined;
  try {
    await execute(actor, env, claimed, controller, (key) => {
      secret = key;
    });
  } catch (err) {
    // Anything unexpected still ends the task visibly instead of leaving it "running".
    const message = err instanceof ActionError || err instanceof AdapterError ? err.message : 'The task failed unexpectedly.';
    await fail(actor, taskId, redactSecrets(message, [secret]));
  } finally {
    releaseActive(taskId);
  }
}

async function fail(owner: OwnerContext, taskId: string, message: string, usage: { tokensIn: number | null; tokensOut: number | null; estimated: boolean } | null = null): Promise<void> {
  const row = await owner.data.tasks.transition(taskId, ['running', 'pending'], {
    status: 'failed',
    error: message.slice(0, 600),
    finished: true,
    ...(usage ? { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, tokensEstimated: usage.estimated } : {}),
  });
  if (row) {
    await owner.data.audit.record({ actor: owner.actor, action: 'ai_task.failed', entityType: 'ai_task', entityId: taskId });
    await announce(owner, row);
  }
}

async function execute(owner: OwnerContext, env: AiEnv, task: AiTask, controller: AbortController, learnSecret: (key: string | undefined) => void): Promise<void> {
  if (!task.providerId) return fail(owner, task.id, 'The provider for this task was removed. Start a new task.');
  const provider = await owner.data.providers.getWithKey(task.providerId);
  if (!provider || !executesTasks(provider.kind)) return fail(owner, task.id, 'The provider for this task is not available.');
  try {
    learnSecret(plainKey(env, provider));
  } catch {
    /* adapterFor reports an unreadable key below */
  }

  try {
    await ensureUnderCap(owner, provider, env.now?.() ?? new Date());
  } catch (err) {
    return fail(owner, task.id, err instanceof ActionError ? err.message : 'The monthly cap blocked this task.');
  }

  // An identical request was answered before: reuse it. Nothing is sent and nothing is spent.
  if (task.requestHash) {
    const cached = await owner.data.tasks.findCached(task.requestHash);
    if (cached?.result && cached.id !== task.id) {
      const row = await owner.data.tasks.transition(task.id, ['running'], {
        status: 'needs_review',
        result: cached.result,
        error: null,
        model: cached.model,
        tokensIn: 0,
        tokensOut: 0,
        tokensEstimated: false,
        fromCache: true,
        finished: true,
      });
      if (row) await announce(owner, row);
      return;
    }
  }

  let adapter;
  try {
    adapter = adapterFor(env, provider);
  } catch (err) {
    return fail(owner, task.id, err instanceof AdapterError ? err.message : 'The provider could not be set up.');
  }
  const system = task.promptText?.split('\n\n---\n\n')[0] ?? '';
  const user = task.promptText?.split('\n\n---\n\n').slice(1).join('\n\n---\n\n') ?? '';
  const maxOutputTokens = provider.protocol === 'anthropic' ? 8000 : 4096;
  const timeoutMs = env.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

  for (let attempt = 1; attempt <= 2; attempt++) {
    await owner.data.tasks.bumpAttempts(task.id);
    try {
      const answer = await adapter.complete({ system, user, maxOutputTokens, signal: controller.signal, timeoutMs });
      const tokensIn = answer.usage.inputTokens ?? estimateTokens(task.promptText ?? '');
      const tokensOut = answer.usage.outputTokens ?? estimateTokens(answer.text);
      const usage = { tokensIn, tokensOut, estimated: answer.usage.inputTokens === null || answer.usage.outputTokens === null };
      try {
        const result = parseModelResult(task.kind, answer.text);
        if (!originalsInsideExcerpt(task.excerpt, result)) {
          return fail(owner, task.id, 'The model proposed a change outside the text you selected, so the result was discarded. Nothing was changed.', usage);
        }
        const row = await owner.data.tasks.transition(task.id, ['running'], {
          status: 'needs_review',
          result,
          error: null,
          model: answer.model ?? provider.model,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          tokensEstimated: usage.estimated,
          finished: true,
        });
        if (row) await announce(owner, row);
        return;
      } catch (err) {
        if (!(err instanceof ResultRejected)) throw err;
        const cut = answer.truncated ? ' The answer was cut off because the model ran out of room to write.' : '';
        return fail(owner, task.id, `The model’s answer could not be used. ${err.message}${cut} Nothing was changed; you can run it again.`, usage);
      }
    } catch (err) {
      if (!(err instanceof AdapterError)) throw err;
      if (err.kind === 'cancelled') return; // the cancel already set the state
      if (err.retryable && attempt === 1) {
        await (env.sleep ?? defaultSleep)(Math.min(err.options.retryAfterMs ?? 1500, 10_000));
        if (controller.signal.aborted) return;
        continue;
      }
      return fail(owner, task.id, err.message);
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

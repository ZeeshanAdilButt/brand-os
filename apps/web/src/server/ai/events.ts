import type { TaskEvent } from '../../lib/ai';

/**
 * In-process change notifications for the task inbox. A subscriber is one open event stream for one
 * owner; an event is delivered only to that owner's subscribers. The bus lives in the server process, which
 * is right for local mode and a single hosted instance; several instances would need a shared channel
 * (see DECISIONS.md). Events are published after the change is committed, never before.
 */

type Listener = (event: TaskEvent) => void;

const globalForBus = globalThis as typeof globalThis & { __cphAiBus?: Map<string, Set<Listener>> };

function bus(): Map<string, Set<Listener>> {
  globalForBus.__cphAiBus ??= new Map();
  return globalForBus.__cphAiBus;
}

export function subscribeTaskEvents(ownerId: string, listener: Listener): () => void {
  const listeners = bus().get(ownerId) ?? new Set<Listener>();
  listeners.add(listener);
  bus().set(ownerId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) bus().delete(ownerId);
  };
}

export function publishTaskEvent(ownerId: string, event: TaskEvent): void {
  for (const listener of bus().get(ownerId) ?? []) {
    try {
      listener(event);
    } catch {
      // A broken stream must not stop the others, or the action that caused the event.
    }
  }
}

export function subscriberCount(ownerId: string): number {
  return bus().get(ownerId)?.size ?? 0;
}

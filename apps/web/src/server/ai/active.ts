/**
 * Tasks this process is running right now, each with the controller that cancels its model call. The map
 * is how a cancel reaches a call in flight, and how a restart is told apart from a task that is still
 * working: anything "running" in the database that is not in here has been lost.
 */
const globalForActive = globalThis as typeof globalThis & { __cphActiveTasks?: Map<string, AbortController> };

function active(): Map<string, AbortController> {
  globalForActive.__cphActiveTasks ??= new Map();
  return globalForActive.__cphActiveTasks;
}

export function registerActive(taskId: string, controller: AbortController): void {
  active().set(taskId, controller);
}

export function releaseActive(taskId: string): void {
  active().delete(taskId);
}

/** Cancel the model call for a task, if this process is making one. */
export function abortActive(taskId: string): void {
  active().get(taskId)?.abort();
}

export function activeTaskIds(): string[] {
  return [...active().keys()];
}

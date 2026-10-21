import type { BufferAlert } from './routes/buffer.js';
import { redact } from './secrets/redact.js';

export type ToastLevel = 'info' | 'warning' | 'critical';

/**
 * Desktop toasts for states the owner must see even with the dashboard closed: a publish whose result
 * is unknown, a remote scheduled post that could not be cancelled, a Buffer stage that was not a
 * draft. A toast is a notice, never an approval channel (a model can read the screen).
 * `toast` never rejects: a notification that fails to show must not break the action it reports.
 */
export interface Notifier {
  toast(title: string, body: string, level: ToastLevel): Promise<void>;
}

/** The slice of node-notifier used here. */
interface NodeNotifierModule {
  notify(options: { title: string; message: string; sound?: boolean; wait?: boolean; appID?: string }, callback?: (error: Error | null) => void): unknown;
}

// Typed as `string` so the dynamic import stays untyped (node-notifier ships no types).
const NODE_NOTIFIER: string = 'node-notifier';
const APP_ID = 'content-powerhouse';
const MAX_BODY = 500;

export interface NodeNotifierOptions {
  /** Called when a toast cannot be shown (logged by the daemon). Default: ignore. */
  onError?: (error: unknown) => void;
}

/**
 * Production toasts through node-notifier (Windows toast notifications). The package loads on the
 * first toast, inside this factory's closure, so nothing else ever imports it and tests use a fake.
 */
export function createNodeNotifier(options: NodeNotifierOptions = {}): Notifier {
  let loaded: Promise<NodeNotifierModule> | undefined;
  const load = (): Promise<NodeNotifierModule> => {
    loaded ??= import(NODE_NOTIFIER).then((mod: { default?: NodeNotifierModule } & NodeNotifierModule) => mod.default ?? mod);
    return loaded;
  };
  return {
    async toast(title, body, level) {
      try {
        const notifier = await load();
        await new Promise<void>((resolve) => {
          notifier.notify(
            { title: redact(title).slice(0, 100), message: redact(body).slice(0, MAX_BODY), sound: level === 'critical', wait: false, appID: APP_ID },
            (error) => {
              if (error !== null && error !== undefined) options.onError?.(error);
              resolve();
            },
          );
        });
      } catch (error) {
        options.onError?.(error);
      }
    },
  };
}

/** Adapts a notifier to the Buffer route's `alert` dependency. */
export function bufferAlertNotifier(notifier: Notifier): (alert: BufferAlert) => void {
  return (alert) => {
    const body = alert.link === undefined ? alert.message : `${alert.message} ${alert.link}`;
    void notifier.toast(alert.title, body, alert.level);
  };
}

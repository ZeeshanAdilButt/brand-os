import type { Notifier, ToastLevel } from '../../src/notify.js';

/** Records every toast instead of showing it. */
export class FakeNotifier implements Notifier {
  readonly toasts: { title: string; body: string; level: ToastLevel }[] = [];

  toast(title: string, body: string, level: ToastLevel): Promise<void> {
    this.toasts.push({ title, body, level });
    return Promise.resolve();
  }
}

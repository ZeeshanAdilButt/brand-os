import type { ArticleStatus } from './articles';

/**
 * The save logic of the article editor, with no React and no fetch in it, so it can be tested.
 *
 * The editor reports every change with `edit(draft)`. After a quiet moment (debounce) the controller
 * sends only the fields that differ from the last copy the server confirmed, together with the
 * revision it last saw. Rules:
 *
 *  - one request at a time; edits that arrive meanwhile are sent afterwards;
 *  - the server answers with the new revision, or 409 and ITS current copy: the controller then stops
 *    and waits for the person to choose (keepMine overwrites on purpose; takeTheirs adopts the server copy);
 *  - a network failure retries with growing delays, or at once on retryNow() / when the browser is back online;
 *  - a field the server rejected (for example a slug someone else now holds) is left out of later
 *    saves until it changes, so one bad field never blocks the rest of the article;
 *  - saveNow() is a deliberate save (a durable history entry); flush() sends pending edits as autosaves
 *    and is what runs when the editor is closed or the page is hidden.
 */

export interface Draft {
  title: string;
  slug: string;
  description: string;
  tags: string[];
  canonicalUrl: string | null;
  coverAssetId: string | null;
  status: ArticleStatus;
  bodyMarkdown: string;
}

export const DRAFT_KEYS = ['title', 'slug', 'description', 'tags', 'canonicalUrl', 'coverAssetId', 'status', 'bodyMarkdown'] as const satisfies readonly (keyof Draft)[];
export type DraftKey = (typeof DRAFT_KEYS)[number];

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'offline' | 'conflict';

export type SendOutcome =
  | { kind: 'ok'; revision: number; draft: Draft }
  | { kind: 'conflict'; revision: number; draft: Draft }
  | { kind: 'invalid'; message: string; fields: Record<string, string> }
  | { kind: 'error'; message: string; offline: boolean };

export interface SendRequest {
  patch: Partial<Draft>;
  expectedRevision: number;
  reason: 'autosave' | 'manual';
}

export interface ControllerStatus {
  state: SaveState;
  revision: number;
  savedAt: number | null;
  message: string | null;
  fieldErrors: Record<string, string>;
  conflict: { draft: Draft; revision: number } | null;
  retryInMs: number | null;
}

export interface ControllerOptions {
  initial: { draft: Draft; revision: number };
  send(request: SendRequest): Promise<SendOutcome>;
  onChange(status: ControllerStatus): void;
  debounceMs?: number;
  retryDelaysMs?: number[];
  now?: () => number;
}

const equal = (a: unknown, b: unknown) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b);

export function draftDiff(from: Draft, to: Draft, skip: ReadonlySet<DraftKey> = new Set()): Partial<Draft> {
  const patch: Record<string, unknown> = {};
  for (const key of DRAFT_KEYS) {
    if (!skip.has(key) && !equal(from[key], to[key])) patch[key] = to[key];
  }
  return patch as Partial<Draft>;
}

export class SaveController {
  private current: Draft;
  private saved: Draft;
  private revision: number;
  private state: SaveState = 'saved';
  private savedAt: number | null = null;
  private message: string | null = null;
  private fieldErrors: Record<string, string> = {};
  private conflict: { draft: Draft; revision: number } | null = null;
  private retryInMs: number | null = null;
  private blocked = new Map<DraftKey, unknown>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wanted: 'autosave' | 'manual' | null = null;
  private draining: Promise<void> | null = null;
  private failures = 0;
  /** A failed deliberate save is retried as a deliberate save. */
  private retryReason: 'autosave' | 'manual' | null = null;
  private disposed = false;
  private readonly debounceMs: number;
  private readonly retryDelays: number[];
  private readonly now: () => number;

  constructor(private readonly options: ControllerOptions) {
    this.current = options.initial.draft;
    this.saved = options.initial.draft;
    this.revision = options.initial.revision;
    this.debounceMs = options.debounceMs ?? 1500;
    this.retryDelays = options.retryDelaysMs ?? [3000, 6000, 12000, 30000];
    this.now = options.now ?? Date.now;
  }

  getStatus(): ControllerStatus {
    return {
      state: this.state,
      revision: this.revision,
      savedAt: this.savedAt,
      message: this.message,
      fieldErrors: this.fieldErrors,
      conflict: this.conflict,
      retryInMs: this.retryInMs,
    };
  }

  private emit(): void {
    if (!this.disposed) this.options.onChange(this.getStatus());
  }

  private setState(state: SaveState, message: string | null = null): void {
    this.state = state;
    this.message = message;
    this.emit();
  }

  private skipped(): ReadonlySet<DraftKey> {
    const skip = new Set<DraftKey>();
    for (const [key, valueAtBlock] of this.blocked) {
      if (equal(this.current[key], valueAtBlock)) skip.add(key);
      else this.blocked.delete(key); // edited since: try it again
    }
    return skip;
  }

  private pending(): Partial<Draft> {
    return draftDiff(this.saved, this.current, this.skipped());
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.retryInMs = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.retryInMs = null;
      this.wanted ??= this.retryReason ?? 'autosave';
      void this.drain();
    }, ms);
  }

  /** Report the editor's full current content. Cheap; call on every change. */
  edit(draft: Draft): void {
    this.current = draft;
    if (this.state === 'conflict' || this.state === 'saving') {
      // While a request is out the result decides what is still pending. A conflict waits for the person.
      return;
    }
    if (Object.keys(this.pending()).length === 0) {
      this.clearTimer();
      if (this.state === 'dirty' || this.state === 'error' || this.state === 'offline') this.setState('saved');
      return;
    }
    this.fieldErrors = {};
    this.setState('dirty');
    this.schedule(this.debounceMs);
  }

  /** A deliberate save: sent now, and it leaves a durable entry in the version history. */
  saveNow(): Promise<void> {
    if (this.state === 'conflict') return Promise.resolve();
    this.clearTimer();
    this.wanted = 'manual';
    return this.drain();
  }

  /** Send anything pending as autosaves, now. Used when the editor closes or the page is hidden. */
  flush(): Promise<void> {
    if (this.state === 'conflict' || this.disposed) return this.draining ?? Promise.resolve();
    if (Object.keys(this.pending()).length === 0 && this.state !== 'saving') return this.draining ?? Promise.resolve();
    this.clearTimer();
    this.wanted ??= 'autosave';
    return this.drain();
  }

  /** Try again right now (the retry button, or the browser coming back online). */
  retryNow(): Promise<void> {
    if (this.state !== 'error' && this.state !== 'offline') return this.draining ?? Promise.resolve();
    this.clearTimer();
    this.wanted ??= this.retryReason ?? 'autosave';
    return this.drain();
  }

  /** The server copy replaces what the controller holds (after a restore, or taking the other version). */
  adopt(copy: { draft: Draft; revision: number }): void {
    this.clearTimer();
    this.current = copy.draft;
    this.saved = copy.draft;
    this.revision = copy.revision;
    this.conflict = null;
    this.blocked.clear();
    this.fieldErrors = {};
    this.failures = 0;
    this.retryReason = null;
    this.wanted = null;
    this.savedAt = this.now();
    this.setState('saved');
  }

  /** Conflict choice: overwrite the other version with this one. */
  keepMine(): Promise<void> {
    if (!this.conflict) return Promise.resolve();
    this.saved = this.conflict.draft;
    this.revision = this.conflict.revision;
    this.conflict = null;
    this.wanted = 'manual';
    return this.drain();
  }

  /** Conflict choice: drop my edits and take the other version. The caller puts `draft` into the editor. */
  takeTheirs(): { draft: Draft; revision: number } | null {
    if (!this.conflict) return null;
    const copy = this.conflict;
    this.adopt(copy);
    return copy;
  }

  dispose(): void {
    this.clearTimer();
    this.disposed = true;
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    const run = (async () => {
      try {
        while (this.wanted && !this.disposed) {
          const reason = this.wanted;
          this.wanted = null;
          const proceed = await this.attempt(reason);
          if (!proceed) break;
        }
      } finally {
        this.draining = null;
      }
    })();
    this.draining = run;
    return run;
  }

  /** One request. Returns true when the loop should look for more work. */
  private async attempt(reason: 'autosave' | 'manual'): Promise<boolean> {
    const patch = this.pending();
    if (Object.keys(patch).length === 0 && reason === 'autosave') {
      this.setState('saved');
      return false;
    }
    this.setState('saving');
    const outcome = await this.options.send({ patch, expectedRevision: this.revision, reason });
    if (this.disposed) return false;

    switch (outcome.kind) {
      case 'ok': {
        this.saved = outcome.draft;
        this.revision = outcome.revision;
        this.savedAt = this.now();
        this.failures = 0;
        this.retryReason = null;
        // Keep the message for a field that is still being held back; clear the rest.
        this.skipped();
        this.fieldErrors = Object.fromEntries(Object.entries(this.fieldErrors).filter(([key]) => this.blocked.has(key as DraftKey)));
        if (Object.keys(this.pending()).length > 0) {
          // More was typed while this request was out: quietly send it after the usual pause.
          this.setState('dirty');
          this.schedule(this.debounceMs);
        } else {
          this.setState('saved');
        }
        return false;
      }
      case 'conflict': {
        this.conflict = { draft: outcome.draft, revision: outcome.revision };
        this.setState('conflict', 'This article was changed somewhere else since you opened it.');
        return false;
      }
      case 'invalid': {
        this.fieldErrors = outcome.fields;
        for (const field of Object.keys(outcome.fields)) {
          if ((DRAFT_KEYS as readonly string[]).includes(field)) this.blocked.set(field as DraftKey, this.current[field as DraftKey]);
        }
        const rest = this.pending();
        if (Object.keys(rest).length > 0) {
          this.wanted = reason;
          this.setState('error', outcome.message);
          return true;
        }
        this.setState('error', outcome.message);
        return false;
      }
      case 'error': {
        this.failures += 1;
        this.retryReason = reason === 'manual' ? 'manual' : this.retryReason;
        const delay = this.retryDelays[Math.min(this.failures - 1, this.retryDelays.length - 1)] ?? 30000;
        this.setState(outcome.offline ? 'offline' : 'error', outcome.message);
        this.schedule(delay);
        this.retryInMs = delay;
        this.emit();
        this.wanted = null;
        return false;
      }
    }
  }
}

import type { Draft, LinkedinPayload } from '@cph/core';
import { GateError } from '../gate/errors.js';
import { assertVerifiedApproval, type VerifiedApproval } from '../gate/verified.js';
import type { AssistKit, Health, Publication, Route } from './types.js';

export type { AssistKit } from './types.js';

/** Where the hand-off sends the user. Prefilling the composer from a URL parameter is UNVERIFIED, so it is not used. */
export const LINKEDIN_FEED_URL = 'https://www.linkedin.com/feed/';
const LINKEDIN_HOST = 'www.linkedin.com';

export const LINKEDIN_ASSIST_CHECKLIST: readonly string[] = Object.freeze([
  'Click "Start a post"',
  'Paste (Ctrl+V)',
  'Check the link preview',
  'Click Post',
  'Paste the post URL back with record_publication',
]);

export interface AssistLinkedinDeps {
  clipboard: { write(text: string): Promise<void> };
  opener: (url: string) => Promise<void>;
}

/**
 * LinkedIn by hand. The route copies the post text and opens the feed; the user pastes and clicks
 * Post themselves. It never publishes: `publish` always refuses. Hand-off is still gated (it is the
 * step before the user's own click, and gating keeps the audit log complete), so `handOff` takes a
 * `VerifiedApproval` that must match the draft as it is now.
 */
export class AssistLinkedinRoute implements Route<LinkedinPayload> {
  readonly kind = 'assist' as const;
  readonly platform = 'linkedin' as const;
  readonly #deps: AssistLinkedinDeps;

  constructor(deps: AssistLinkedinDeps) {
    this.#deps = deps;
  }

  async health(_account: string): Promise<Health> {
    return { state: 'manual_only' };
  }

  async handOff(d: Draft<LinkedinPayload>, a: VerifiedApproval): Promise<AssistKit> {
    assertVerifiedApproval(a);
    if (a.draftId !== d.id) {
      throw new GateError('NO_APPROVAL', 'the approval was granted for a different draft', { draftId: d.id });
    }
    if (a.payloadSha256 !== d.payloadSha256) {
      throw new GateError('HASH_MISMATCH', 'the approval does not cover the draft as it is now', { draftId: d.id });
    }
    await this.#deps.clipboard.write(d.payload.text);
    await this.#deps.opener(LINKEDIN_FEED_URL);
    return { copiedText: d.payload.text, openUrl: LINKEDIN_FEED_URL, checklist: [...LINKEDIN_ASSIST_CHECKLIST] };
  }

  async publish(d: Draft<LinkedinPayload>, _a: VerifiedApproval): Promise<Publication> {
    throw new GateError('WRONG_CHANNEL', 'an assist route never publishes; the user posts it on LinkedIn themselves', {
      draftId: d.id,
    });
  }

  costEstimate(_d: Draft<LinkedinPayload>): number {
    return 0;
  }
}

/**
 * Checks the URL a user pastes back with `record_publication` and returns it normalised: https, on
 * `www.linkedin.com`, no credentials, no custom port. The database write belongs to T0.17.
 */
export function validateLinkedinPostUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error('the post URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('the post URL must use https');
  if (parsed.hostname !== LINKEDIN_HOST) throw new Error(`the post URL must be on ${LINKEDIN_HOST}`);
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
    throw new Error('the post URL must not carry credentials or a port');
  }
  return parsed.href;
}

/**
 * Production wiring: the real clipboard and browser. The two packages load on first use, so nothing
 * but this factory ever touches them; tests build `AssistLinkedinRoute` with fakes instead.
 */
export function createAssistLinkedinRoute(): AssistLinkedinRoute {
  return new AssistLinkedinRoute({
    clipboard: {
      write: async (text) => {
        const { default: clipboard } = await import('clipboardy');
        await clipboard.write(text);
      },
    },
    opener: async (url) => {
      const { default: open } = await import('open');
      await open(url);
    },
  });
}

import type { PresenceResult, PresenceVerifier } from '../../src/gate/presence.js';

/**
 * A scripted presence check for tests. It answers every `verify` with `answer` (or throws it, when
 * it is an Error) and records each prompt, so a test can assert what the user would have seen and
 * that a refused approve never reached the presence check at all.
 */
export class FakePresence implements PresenceVerifier {
  readonly prompts: string[] = [];

  constructor(private answer: PresenceResult | Error = 'verified') {}

  set(answer: PresenceResult | Error): void {
    this.answer = answer;
  }

  verify(prompt: string): Promise<PresenceResult> {
    this.prompts.push(prompt);
    if (this.answer instanceof Error) return Promise.reject(this.answer);
    return Promise.resolve(this.answer);
  }
}

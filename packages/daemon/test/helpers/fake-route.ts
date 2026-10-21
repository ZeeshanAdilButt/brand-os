import type { Draft, PlatformId, RouteKind } from '@cph/core';
import { assertVerifiedApproval, type VerifiedApproval } from '../../src/gate/verified.js';
import type { AssistKit, Health, Publication, RemoteRef, Route } from '../../src/routes/types.js';

export interface FakeRouteOptions {
  stage?: boolean;
  checkOnPlatform?: boolean;
  cancelScheduled?: boolean;
  handOff?: boolean;
}

/**
 * A scripted route. It records every call with the draft as the route saw it (so a test can count
 * remote calls and check what would have reached the wire) and answers from replaceable functions.
 * Optional methods exist only when asked for, like on the real routes.
 */
export class FakeRoute implements Route<unknown> {
  readonly publishCalls: { draft: Draft; approval: VerifiedApproval }[] = [];
  readonly stageCalls: Draft[] = [];
  readonly cancelCalls: Draft[] = [];
  readonly checkCalls: Draft[] = [];
  readonly handOffCalls: Draft[] = [];
  readonly healthCalls: string[] = [];

  healthAnswer: Health = { state: 'connected', who: '@fake' };
  publishImpl: (d: Draft) => Promise<Publication> = (d) =>
    Promise.resolve({ remoteId: `remote-${d.id}`, remoteUrl: `https://example.test/${d.platform}/${d.id}`, costUsd: 0 });
  stageImpl: (d: Draft) => Promise<RemoteRef> = () => Promise.resolve({ remoteId: '101', previewUrl: 'https://example.test/preview/101' });
  cancelImpl: (d: Draft) => Promise<void> = () => Promise.resolve();
  checkImpl: (d: Draft) => Promise<'published' | 'not_found' | 'unknown'> = () => Promise.resolve('published');
  handOffImpl: (d: Draft) => Promise<AssistKit> = (d) =>
    Promise.resolve({ copiedText: String((d.payload as { text?: string }).text ?? ''), openUrl: 'https://www.linkedin.com/feed/', checklist: ['Paste'] });

  stage?: (d: Draft) => Promise<RemoteRef>;
  cancelScheduled?: (d: Draft) => Promise<void>;
  checkOnPlatform?: (d: Draft) => Promise<'published' | 'not_found' | 'unknown'>;
  handOff?: (d: Draft, a: VerifiedApproval) => Promise<AssistKit>;

  constructor(
    readonly platform: PlatformId,
    readonly kind: RouteKind,
    options: FakeRouteOptions = {},
  ) {
    if (options.stage === true) {
      this.stage = (d) => {
        this.stageCalls.push(structuredClone(d));
        return this.stageImpl(d);
      };
    }
    if (options.cancelScheduled === true) {
      this.cancelScheduled = (d) => {
        this.cancelCalls.push(structuredClone(d));
        return this.cancelImpl(d);
      };
    }
    if (options.checkOnPlatform === true) {
      this.checkOnPlatform = (d) => {
        this.checkCalls.push(structuredClone(d));
        return this.checkImpl(d);
      };
    }
    if (options.handOff === true) {
      this.handOff = (d, a) => {
        assertVerifiedApproval(a);
        this.handOffCalls.push(structuredClone(d));
        return this.handOffImpl(d);
      };
    }
  }

  health(account: string): Promise<Health> {
    this.healthCalls.push(account);
    return Promise.resolve(this.healthAnswer);
  }

  publish(d: Draft, a: VerifiedApproval): Promise<Publication> {
    assertVerifiedApproval(a);
    this.publishCalls.push({ draft: structuredClone(d), approval: a });
    return this.publishImpl(d);
  }

  costEstimate(): number {
    return 0;
  }
}

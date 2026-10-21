import {
  PLATFORMS,
  approvalTag,
  type ApprovalDTO,
  type AttemptDTO,
  type ConnectionDTO,
  type ErrorKind,
  type PlatformDraftDTO,
} from '../../lib/publishing';
import type { Approval, PlatformConnection, PlatformDraft, PublishAttempt } from '../db/schema';
import type { PlatformAdapter } from './adapters/types';
import { PlatformError } from './errors';
import { waitText } from './http';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toConnectionDTO(row: Omit<PlatformConnection, 'encryptedKey'>): ConnectionDTO {
  return {
    id: row.id,
    platform: row.platform,
    status: row.status,
    who: row.who,
    keyLast4: row.keyLast4,
    config: row.config,
    lastCheckedAt: iso(row.lastCheckedAt),
    lastCheckMessage: row.lastCheckMessage,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAttemptDTO(row: PublishAttempt): AttemptDTO {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    httpStatus: row.httpStatus,
    errorKind: row.errorKind,
    message: row.message,
    remoteId: row.remoteId,
    remoteUrl: row.remoteUrl,
    startedAt: row.startedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
  };
}

export function toApprovalDTO(row: Approval): ApprovalDTO {
  return {
    id: row.id,
    status: row.status,
    tag: row.tag,
    payloadSha256: row.payloadSha256,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    invalidReason: row.invalidReason,
    requestedBy: row.requestedBy,
  };
}

/** The draft as the browser and the agent API see it. `config` is the connection's non-secret settings. */
export function toDraftDTO(
  row: PlatformDraft,
  parts: { approval: Approval | null; attempts: PublishAttempt[]; adapter: PlatformAdapter; config: PlatformConnection['config'] },
): PlatformDraftDTO {
  return {
    id: row.id,
    articleId: row.articleId,
    platform: row.platform,
    status: row.status,
    stale: row.stale,
    payload: row.payload,
    payloadSha256: row.payloadSha256,
    requestPreview: JSON.stringify(parts.adapter.preview(row.payload, true, parts.config, row.remoteId), null, 2),
    tagReport: row.tagReport,
    lint: row.lint,
    account: row.account,
    sourceRevision: row.sourceRevision,
    remoteId: row.remoteId,
    remoteUrl: row.remoteUrl,
    remotePreviewUrl: row.remotePreviewUrl,
    failureKind: row.failureKind,
    failureMessage: row.failureMessage,
    nextAction: row.nextAction,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stagedAt: iso(row.stagedAt),
    publishedAt: iso(row.publishedAt),
    approval: parts.approval ? toApprovalDTO(parts.approval) : null,
    attempts: parts.attempts.map(toAttemptDTO),
  };
}

export interface FailureText {
  kind: ErrorKind;
  message: string;
  nextAction: string;
}

/**
 * Words for a failed platform call: what happened, and the next thing to do. `operation` matters for an
 * ambiguous failure: after a publish it means "may be live", after a stage it only means "try again".
 */
export function describeFailure(platform: keyof typeof PLATFORMS, error: PlatformError, operation: 'stage' | 'publish' | 'check' | 'health'): FailureText {
  const name = PLATFORMS[platform].name;
  const base = error.message;
  switch (error.kind) {
    case 'auth':
      return { kind: error.kind, message: base, nextAction: `Reconnect ${name} in Settings with a new key.` };
    case 'forbidden_plan':
      return { kind: error.kind, message: base, nextAction: 'Upgrade the publication to Pro on Hashnode, then try again.' };
    case 'validation':
      return { kind: error.kind, message: base, nextAction: 'Fix what the platform names, then rebuild the draft and try again.' };
    case 'rate_limit': {
      const wait = error.retryAfterMs ? waitText(error.retryAfterMs) : 'a little while';
      return { kind: error.kind, message: base, nextAction: `Wait ${wait}, then try again.` };
    }
    case 'not_found':
      return { kind: error.kind, message: base, nextAction: 'Stage a new private draft, then try again.' };
    case 'config':
      return { kind: error.kind, message: base, nextAction: 'Fix the setup named above, then try again.' };
    default:
      if (operation === 'publish' && error.ambiguous) {
        return {
          kind: error.kind,
          message: `${base} The post may or may not be live.`,
          nextAction: 'Use “Check on platform”. It will not be retried automatically, and it cannot be approved again until you have checked.',
        };
      }
      return { kind: error.kind, message: base, nextAction: `Try again in a minute. If it keeps failing, check ${name}’s status page.` };
  }
}

export { approvalTag };

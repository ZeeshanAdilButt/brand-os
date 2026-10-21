/**
 * Proof that `ApprovalGate.authorize` ran every precheck and consumed the approval. Routes and the
 * publish service accept only this type, so a publish cannot be reached without going through the
 * gate.
 *
 * Two layers:
 * - compile time: the brand is a `unique symbol` that is never exported, so no other module can
 *   write the type down without a cast;
 * - run time: every minted value is frozen and remembered in a module-private WeakSet, so
 *   `isVerifiedApproval` / `assertVerifiedApproval` reject a cast or hand-built object.
 *
 * `mintVerifiedApproval` may be imported only by gate/approval-gate.ts (a source rule in
 * test/source-rules.test.ts enforces it).
 */
import type { ApprovalMode } from '../db/repos.js';

declare const verifiedBrand: unique symbol;

export type VerifiedApproval = {
  readonly approvalId: string;
  readonly draftId: string;
  readonly payloadSha256: string;
  /** How the approval may be used: the dashboard's Approve & publish, Approve only, or a schedule. */
  readonly mode: ApprovalMode;
  /** The draft's scheduled time covered by the hash, or null. */
  readonly scheduledAt: string | null;
  readonly [verifiedBrand]: true;
};

export interface VerifiedFields {
  approvalId: string;
  draftId: string;
  payloadSha256: string;
  mode: ApprovalMode;
  scheduledAt: string | null;
}

const minted = new WeakSet<object>();

export function mintVerifiedApproval(fields: VerifiedFields): VerifiedApproval {
  const value = Object.freeze({
    approvalId: fields.approvalId,
    draftId: fields.draftId,
    payloadSha256: fields.payloadSha256,
    mode: fields.mode,
    scheduledAt: fields.scheduledAt,
  });
  minted.add(value);
  return value as unknown as VerifiedApproval;
}

export function isVerifiedApproval(value: unknown): value is VerifiedApproval {
  return typeof value === 'object' && value !== null && minted.has(value);
}

export function assertVerifiedApproval(value: unknown): asserts value is VerifiedApproval {
  if (!isVerifiedApproval(value)) throw new TypeError('not a VerifiedApproval minted by the approval gate');
}

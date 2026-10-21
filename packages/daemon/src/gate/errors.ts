/**
 * Why the approval gate refused. Every refusal is audited with its code (spec 2.6).
 */
export type GateCode =
  | 'NO_APPROVAL'
  | 'NOT_APPROVED'
  | 'EXPIRED'
  | 'USED'
  | 'HASH_MISMATCH'
  | 'SOURCE_CHANGED'
  | 'PUBLISHING_DISABLED'
  | 'CANONICAL_NOT_LIVE'
  | 'LINT_ERRORS'
  | 'NOT_BEFORE'
  | 'DUPLICATE'
  | 'UNHEALTHY'
  | 'CHECKLIST_INCOMPLETE'
  | 'WRONG_CHANNEL'
  | 'PRESENCE_FAILED'
  | 'BUDGET_LOW'
  | 'REMOTE_SCHEDULED';

export class GateError extends Error {
  override readonly name = 'GateError';

  constructor(
    readonly code: GateCode,
    message: string,
    /** Structured context for the caller and the audit row. Never contains secrets. */
    readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
  }
}

import type { AuditEntry, Repos } from './db/repos.js';
import { redact } from './secrets/redact.js';

/** Appends one audit row and returns its id. Every `detail` passes through `redactDetail` first. */
export type Audit = (entry: AuditEntry) => number;

const MASK = '[REDACTED]';
/** A value under one of these keys is masked whole, whatever it looks like. */
const SECRET_KEY = /api[-_]?key|secret|token|password|passwd|authorization|cookie/i;
/** Keys that hold a payload hash; their exact 64-hex value is kept (redact would mask any hex digest). */
const HASH_KEYS: ReadonlySet<string> = new Set(['hash', 'oldHash', 'newHash', 'payloadSha256']);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_DEPTH = 8;

/**
 * A copy of `value` safe to store in the audit log: every string goes through `redact`, a value
 * under a secret-looking key is masked whole, and nesting is cut off at a fixed depth.
 */
export function redactDetail(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return MASK;
  if (Array.isArray(value)) return value.map((item) => redactDetail(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (HASH_KEYS.has(key) && typeof inner === 'string' && SHA256_HEX.test(inner)) out[key] = inner;
    else if (SECRET_KEY.test(key)) out[key] = MASK;
    else out[key] = redactDetail(inner, depth + 1);
  }
  return out;
}

/** The audit helper the services use. The gate keeps writing its own rows through `repos.audit`. */
export function createAudit(repos: Repos): Audit {
  return (entry) => {
    const { detail, ...rest } = entry;
    return repos.audit.append(detail === undefined ? rest : { ...rest, detail: redactDetail(detail) });
  };
}

/** The text of an error, redacted, for a failure reason or an audit row. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}` : String(error);
  return redact(text).slice(0, 2000);
}

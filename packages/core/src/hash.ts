import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { PlatformId, RouteKind } from './ids.js';

export interface PayloadHashInput {
  platform: PlatformId;
  account: string;
  route: RouteKind;
  payload: unknown;
  /** Order matters: media order is user-visible. */
  mediaSha256: string[];
  scheduledAt: string | null;
}

/**
 * Lowercase hex SHA-256 of the RFC 8785 canonical JSON of the input. This is the hash an
 * approval is bound to, so it must cover every field that reaches the wire.
 */
export function payloadHash(input: PayloadHashInput): string {
  const canonical = canonicalize(input);
  if (canonical === undefined) throw new TypeError('payload is not representable as JSON');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

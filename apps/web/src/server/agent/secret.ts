import { createHash, randomBytes } from 'node:crypto';
import { CREDENTIAL_PREFIX } from '../../lib/agent';

/** 32 random bytes as base64url is 43 characters. */
const BODY_LENGTH = 43;
const BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface NewSecret {
  /** The full secret. Shown to the person once and never stored. */
  secret: string;
  /** Hex SHA-256 of the secret: the only thing the database keeps. */
  hash: string;
  /** The first characters, for telling credentials apart in a list. */
  prefix: string;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** A new random secret. 256 bits of randomness, so a fast hash is enough to protect it at rest. */
export function generateSecret(): NewSecret {
  const secret = `${CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { secret, hash: hashSecret(secret), prefix: secret.slice(0, CREDENTIAL_PREFIX.length + 4) };
}

/** True for a string shaped like one of our secrets. Checked before any lookup so junk never reaches the database. */
export function looksLikeSecret(value: string): boolean {
  return value.startsWith(CREDENTIAL_PREFIX) && value.length === CREDENTIAL_PREFIX.length + BODY_LENGTH && BODY_PATTERN.test(value.slice(CREDENTIAL_PREFIX.length));
}

/** The secret in an `Authorization: Bearer ...` header, or null. */
export function bearerFrom(headers: Headers): string | null {
  const header = headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

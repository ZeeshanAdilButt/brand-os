import { z } from 'zod';
import type { AppDb } from '../db/client';

const ownerIdSchema = z.uuid();

/** Thrown when a row does not exist for this owner. Other owners' rows look exactly the same: absent. */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

/** Thrown when a slug is already used by another of this owner's articles. */
export class SlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`The slug "${slug}" is already used by another article`);
    this.name = 'SlugTakenError';
  }
}

/** True for a Postgres unique-violation, however the driver wrapped it. */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Where a scoped repository gets its connection. A function, so a transaction can be passed in. */
export type DbSource = () => Promise<AppDb>;

/** A validated owner id plus the connection source. Every scoped repository starts from this. */
export interface Scope {
  readonly ownerId: string;
  db(): Promise<AppDb>;
}

/**
 * Validate the owner id (a malformed value must never reach a query) and bind it to a connection.
 * The id is only ever taken from an authenticated session by callers; there is deliberately no
 * overload that reads it from request-shaped input.
 */
export function makeScope(ownerId: string, source: DbSource): Scope {
  const owner = ownerIdSchema.parse(ownerId);
  return { ownerId: owner, db: source };
}

/** Remove undefined keys so a partial update never overwrites a column with undefined. */
export function definedOnly<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<T>;
}

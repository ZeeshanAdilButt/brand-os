import { z } from 'zod';
import type { AppContext } from '../context';
import type { SessionUser } from '../auth/resolve';
import { forOwner, type OwnerData } from '../data/tenant';

/**
 * Who is acting, and on whose data. Built only from a resolved session (see sessionToOwner), so
 * `ownerId` is never something a caller can supply. Actions take this as their first argument and
 * accept no owner id in their input: unknown keys in the input are stripped by the Zod schemas.
 */
export interface OwnerContext {
  readonly ownerId: string;
  readonly actor: 'owner' | 'mcp' | 'ai';
  readonly data: OwnerData;
}

export function sessionToOwner(user: Pick<SessionUser, 'userId'>, ctx: Pick<AppContext, 'db'>, actor: OwnerContext['actor'] = 'owner'): OwnerContext {
  return { ownerId: user.userId, actor, data: forOwner(user.userId, ctx.db) };
}

/** A failure the caller can show: bad input, or something that does not exist for this owner. */
export class ActionError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found',
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

/** Parse input with a Zod schema, turning failures into an ActionError with per-field messages. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  throw new ActionError('invalid', 'Some fields need attention.', fields);
}

const uuid = z.uuid();

/** An id that is not even a UUID is reported as not found, exactly like an id that exists for someone else. */
export function parseId(id: unknown, what: string): string {
  const parsed = uuid.safeParse(id);
  if (!parsed.success) throw new ActionError('not_found', `${what} not found`);
  return parsed.data;
}

/** Split a textarea or comma list into trimmed, unique, non-empty entries. */
export function splitList(value: string, max = 50): string[] {
  const seen = new Set<string>();
  for (const part of value.split(/[\n,]/)) {
    const trimmed = part.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].slice(0, max);
}

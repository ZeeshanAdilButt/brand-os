import { GateError } from '../gate/errors.js';
import { redact } from '../secrets/redact.js';
import type { ApiBudget, BudgetPurpose } from '../services/api-budget.js';
import { parseRetryAfter, platformFetchOptions, PlatformError } from './types.js';

export const BUFFER_API_URL = 'https://api.buffer.com';

const MAX_BODY_CHARS = 4000;

/**
 * Everything below that is marked UNVERIFIED is a best guess at Buffer's GraphQL schema. Spike S2
 * replaces each one with the introspected name; until then they live in these constants only, so a
 * wrong guess is a one-line fix and shows up as a GraphQL error, never as a silent wrong post.
 */

/** Fields read from a channel. `isDisconnected` is UNVERIFIED until S2(d). */
export const BUFFER_CHANNEL_FIELDS = 'id name service isDisconnected';

const ORGANIZATIONS_QUERY = 'query Organizations { account { organizations { id name } } }';

/** Verified shape (first-post guide): `channels(input:{organizationId}){id name service}`. */
const channelsQuery = (organizationId: string): string =>
  `query Channels { channels(input: { organizationId: ${JSON.stringify(organizationId)} }) { ${BUFFER_CHANNEL_FIELDS} } }`;

/** The input type name `CreatePostInput` is UNVERIFIED until S2. The response union is verified. */
const CREATE_POST_MUTATION = `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id status } }
    ... on MutationError { message }
  }
}`;

/** UNVERIFIED until S2(h): the mutation name `deletePost` and its `id` input field. */
const deletePostMutation = (postId: string): string =>
  `mutation DeletePost { deletePost(input: { id: ${JSON.stringify(postId)} }) { __typename ... on MutationError { message } } }`;

/** UNVERIFIED until S2: whether a post can be read back by id, and the field names. */
const getPostQuery = (postId: string): string => `query GetPost { post(input: { id: ${JSON.stringify(postId)} }) { id status } }`;

export type BufferCreatePostInput = {
  channelId: string;
  text: string;
  schedulingType: 'automatic';
  mode: 'shareNow' | 'customScheduled' | 'addToQueue';
  dueAt?: string;
  saveToDraft?: boolean;
  assets?: ({ image: { url: string } } | { video: { url: string } } | { document: { url: string } })[];
  /** Field names under `linkedin` are UNVERIFIED until S2(e). */
  metadata?: { linkedin?: { linkAttachment?: { url: string; title: string; description: string; thumbnailUrl: string } } };
};

export interface BufferOrganization {
  id: string;
  name: string;
}
export interface BufferChannel {
  id: string;
  name: string;
  service: string;
  isDisconnected?: boolean;
}
export interface BufferPost {
  id: string;
  status: string;
}

/** Buffer answered HTTP 200 with a `MutationError`: nothing was done, and the message says why. */
export class BufferMutationError extends Error {
  override readonly name = 'BufferMutationError';
}

/** Buffer answered with a GraphQL `errors` array (a validation or execution error). */
export class BufferGraphQLError extends Error {
  override readonly name = 'BufferGraphQLError';
}

type Json = Record<string, unknown>;

/**
 * Buffer's GraphQL API (`https://api.buffer.com`, `Authorization: Bearer <key>`), with the API
 * budget in front of it.
 *
 * - Every response's remaining-quota headers, and the call itself, go into `ApiBudget`.
 * - A call with purpose other than `publish` is refused with `BUDGET_LOW`, without a request, when
 *   less than 20% of the 24 h or 30 d budget remains.
 * - Nothing retries. Every error text passes the key scrub and `redact`.
 */
export class BufferClient {
  readonly #apiKey: string;
  readonly #fetchFn: typeof fetch;
  readonly #budget: ApiBudget;
  readonly #now: () => Date;

  constructor(apiKey: string, fetchFn: typeof fetch, budget: ApiBudget, now: () => Date = () => new Date()) {
    this.#apiKey = apiKey;
    this.#fetchFn = fetchFn;
    this.#budget = budget;
    this.#now = now;
  }

  async gql<T>(query: string, variables?: object, opts: { purpose: BudgetPurpose } = { purpose: 'other' }): Promise<T> {
    if (!this.#budget.allows('buffer', opts.purpose)) {
      const { d1, d30 } = this.#budget.snapshot('buffer');
      throw new GateError(
        'BUDGET_LOW',
        `Buffer API budget is low (${d1.remaining}/${d1.limit} left in 24 h, ${d30.remaining}/${d30.limit} in 30 d); the rest is kept for publishing`,
        { provider: 'buffer', purpose: opts.purpose, d1, d30 },
      );
    }
    const label = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'request';
    const body = JSON.stringify(variables === undefined ? { query } : { query, variables });
    let res: Response;
    let text: string;
    try {
      res = await this.#fetchFn(BUFFER_API_URL, {
        method: 'POST',
        ...platformFetchOptions(),
        headers: { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body,
      });
      text = await res.text();
    } catch (cause) {
      // The request may have reached Buffer and been counted, so it counts here too.
      this.#budget.record('buffer', new Headers());
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Buffer ${label} request failed: ${this.#scrub(reason)}`);
    }
    this.#budget.record('buffer', res.headers);

    if (!res.ok) {
      const detail = this.#scrub(text).slice(0, MAX_BODY_CHARS);
      throw new PlatformError(
        `Buffer ${label} failed with ${res.status}${detail === '' ? '' : `: ${detail}`}`,
        res.status,
        parseRetryAfter(res.headers.get('retry-after'), this.#now()),
        detail,
      );
    }
    const parsed = parseJson(text);
    if (parsed === undefined) throw new Error(`Buffer ${label} returned an answer that is not JSON (status ${res.status})`);
    const errors = parsed['errors'];
    if (Array.isArray(errors) && errors.length > 0) {
      const messages = errors.map((e) => (typeof (e as Json | null)?.['message'] === 'string' ? ((e as Json)['message'] as string) : 'unknown error'));
      throw new BufferGraphQLError(`Buffer ${label} returned errors: ${this.#scrub(messages.join('; ')).slice(0, MAX_BODY_CHARS)}`);
    }
    const data = parsed['data'];
    if (typeof data !== 'object' || data === null) throw new Error(`Buffer ${label} returned no data`);
    return data as T;
  }

  /** Only at connect time; the id is cached in config afterwards. */
  async organizations(): Promise<BufferOrganization[]> {
    const data = await this.gql<{ account?: { organizations?: unknown } }>(ORGANIZATIONS_QUERY, undefined, { purpose: 'other' });
    const list = data.account?.organizations;
    if (!Array.isArray(list)) throw new Error('Buffer returned an unexpected shape for the organizations query');
    return list.filter(isRecord).map((o) => ({ id: String(o['id']), name: String(o['name'] ?? '') }));
  }

  /** One call. `purpose` is `probe` unless the caller is the pre-publish check. */
  async channels(organizationId: string, opts: { purpose: BudgetPurpose } = { purpose: 'probe' }): Promise<BufferChannel[]> {
    const data = await this.gql<{ channels?: unknown }>(channelsQuery(organizationId), undefined, opts);
    if (!Array.isArray(data.channels)) throw new Error('Buffer returned an unexpected shape for the channels query');
    return data.channels.filter(isRecord).map((c) => {
      const channel: BufferChannel = { id: String(c['id']), name: String(c['name'] ?? ''), service: String(c['service'] ?? '') };
      return typeof c['isDisconnected'] === 'boolean' ? { ...channel, isDisconnected: c['isDisconnected'] } : channel;
    });
  }

  /**
   * A draft (`saveToDraft: true`) is budgeted as a `stage`; anything else is a real post and is
   * never refused by the budget guard. Throws `BufferMutationError` on a `MutationError` answer.
   */
  async createPost(input: BufferCreatePostInput): Promise<BufferPost> {
    const purpose: BudgetPurpose = input.saveToDraft === true ? 'stage' : 'publish';
    const data = await this.gql<{ createPost?: unknown }>(CREATE_POST_MUTATION, { input }, { purpose });
    const result = this.#union(data.createPost, 'createPost');
    const post = result['post'];
    if (!isRecord(post) || typeof post['id'] !== 'string' || typeof post['status'] !== 'string') {
      throw new Error('Buffer createPost answered without a post id and status');
    }
    return { id: post['id'], status: post['status'] };
  }

  /**
   * Deleting is the cleanup for a bad stage and the cancel for a scheduled post, so it is never
   * refused by the budget guard (same class as a publish). Controller-approved exception: a starved
   * cleanup could leave a post queued or live.
   */
  async deletePost(postId: string): Promise<void> {
    const data = await this.gql<{ deletePost?: unknown }>(deletePostMutation(postId), undefined, { purpose: 'publish' });
    this.#union(data.deletePost, 'deletePost');
  }

  /**
   * Reads a post by id, or `null` when Buffer does not know it. UNVERIFIED query, see above. This is
   * the recovery read-back for a publish that may have gone out. It is budgeted as `recovery`: below
   * 20% remaining it is refused like any non-publish call (spec 4.4), so a draft stuck in `unknown`
   * cannot eat the quota that publishing needs.
   */
  async post(postId: string): Promise<BufferPost | null> {
    const data = await this.gql<{ post?: unknown }>(getPostQuery(postId), undefined, { purpose: 'recovery' });
    const post = data.post;
    if (post === null || post === undefined) return null;
    if (!isRecord(post) || typeof post['id'] !== 'string') throw new Error('Buffer returned an unexpected shape for the post query');
    return { id: post['id'], status: typeof post['status'] === 'string' ? post['status'] : '' };
  }

  /** A mutation result union: a `MutationError` becomes `BufferMutationError`, anything else is the success arm. */
  #union(value: unknown, name: string): Json {
    if (!isRecord(value)) throw new Error(`Buffer ${name} returned no result`);
    if (value['__typename'] === 'MutationError') {
      const message = typeof value['message'] === 'string' ? value['message'] : 'no message';
      throw new BufferMutationError(`Buffer rejected ${name}: ${this.#scrub(message).slice(0, MAX_BODY_CHARS)}`);
    }
    return value;
  }

  #scrub(text: string): string {
    return redact(this.#apiKey === '' ? text : text.split(this.#apiKey).join('[REDACTED]'));
  }
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

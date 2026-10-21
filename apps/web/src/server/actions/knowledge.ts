import { z } from 'zod';
import { NotFoundError } from '../data/scope';
import type { ItemFilter, SearchHit } from '../data/knowledge';
import {
  CONFIDENCE_LEVELS,
  CONFIDENTIALITY_LEVELS,
  ITEM_KINDS,
  SOURCE_KINDS,
  VERIFICATION_STATUSES,
  type KnowledgeItem,
  type KnowledgeSource,
} from '../db/schema';
import { ActionError, parseId, parseInput, type OwnerContext } from './owner';

const MAX_QUERY_LENGTH = 200;

const text = (max: number) => z.string().trim().max(max);
const isoDate = z.iso.date();
const tags = z.array(z.string().trim().min(1).max(40)).max(20).default([]);

/** Fields a person may set on an item. There is no owner id here, by design: unknown keys are dropped. */
export const itemInputSchema = z.object({
  kind: z.enum(ITEM_KINDS),
  title: text(200).min(1, 'Give the item a title.'),
  body: text(20_000).default(''),
  tags,
  sourceId: z.uuid().nullable().default(null),
  sourceDate: isoDate.nullable().default(null),
  verificationStatus: z.enum(VERIFICATION_STATUSES).default('unverified'),
  confidence: z.enum(CONFIDENCE_LEVELS).default('medium'),
  confidentiality: z.enum(CONFIDENTIALITY_LEVELS).default('private'),
  publicUsePermitted: z.boolean().default(false),
});

export const itemPatchSchema = z.object({
  kind: z.enum(ITEM_KINDS),
  title: text(200).min(1, 'Give the item a title.'),
  body: text(20_000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  sourceId: z.uuid().nullable(),
  sourceDate: isoDate.nullable(),
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  confidence: z.enum(CONFIDENCE_LEVELS),
  confidentiality: z.enum(CONFIDENTIALITY_LEVELS),
  publicUsePermitted: z.boolean(),
}).partial();

export const sourceInputSchema = z.object({
  kind: z.enum(SOURCE_KINDS).default('manual'),
  title: text(200).min(1, 'Give the source a title.'),
  uri: text(2000).nullable().default(null),
  sourceDate: isoDate.nullable().default(null),
});

export const listQuerySchema = z.object({
  q: text(MAX_QUERY_LENGTH).optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  confidentiality: z.enum(CONFIDENTIALITY_LEVELS).optional(),
  verificationStatus: z.enum(VERIFICATION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type ListQuery = z.input<typeof listQuerySchema>;

export interface ItemList {
  query: string;
  /** Present for a search: ranked, with highlighted snippets. */
  hits: SearchHit[] | null;
  items: KnowledgeItem[];
}

function toFilter(query: z.output<typeof listQuerySchema>): ItemFilter {
  return {
    kind: query.kind,
    confidentiality: query.confidentiality,
    verificationStatus: query.verificationStatus,
    limit: query.limit,
    offset: query.offset,
  };
}

/** List this owner's items, or search them when `q` is given. Empty strings count as absent. */
export async function listItems(owner: OwnerContext, rawQuery: Record<string, unknown> = {}): Promise<ItemList> {
  const cleaned = Object.fromEntries(Object.entries(rawQuery).filter(([, v]) => v !== undefined && v !== ''));
  const query = parseInput(listQuerySchema, cleaned);
  const filter = toFilter(query);
  if (query.q) {
    const hits = await owner.data.items.search(query.q, filter);
    return { query: query.q, hits, items: hits.map((h) => h.item) };
  }
  return { query: '', hits: null, items: await owner.data.items.list(filter) };
}

export async function getItem(owner: OwnerContext, id: unknown): Promise<KnowledgeItem> {
  const item = await owner.data.items.get(parseId(id, 'Item'));
  if (!item) throw new ActionError('not_found', 'Item not found');
  return item;
}

async function guardNotFound<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof NotFoundError) throw new ActionError('not_found', `${err.message.replace(/ not found$/, '')} not found`);
    throw err;
  }
}

export async function createItem(owner: OwnerContext, input: unknown): Promise<KnowledgeItem> {
  const values = parseInput(itemInputSchema, input);
  const item = await guardNotFound(() => owner.data.items.create(values));
  await owner.data.audit.record({ actor: owner.actor, action: 'knowledge.item_created', entityType: 'knowledge_item', entityId: item.id });
  return item;
}

export async function updateItem(owner: OwnerContext, id: unknown, input: unknown): Promise<KnowledgeItem> {
  const itemId = parseId(id, 'Item');
  const patch = parseInput(itemPatchSchema, input);
  const item = await guardNotFound(() => owner.data.items.update(itemId, patch));
  await owner.data.audit.record({ actor: owner.actor, action: 'knowledge.item_updated', entityType: 'knowledge_item', entityId: item.id });
  return item;
}

/** The owner confirms the claim is accurate. It does not make the item public. */
export async function markReviewed(owner: OwnerContext, id: unknown): Promise<KnowledgeItem> {
  const item = await guardNotFound(() => owner.data.items.markReviewed(parseId(id, 'Item')));
  await owner.data.audit.record({ actor: owner.actor, action: 'knowledge.item_reviewed', entityType: 'knowledge_item', entityId: item.id });
  return item;
}

export async function deleteItem(owner: OwnerContext, id: unknown): Promise<void> {
  const itemId = parseId(id, 'Item');
  const removed = await owner.data.items.remove(itemId);
  if (!removed) throw new ActionError('not_found', 'Item not found');
  await owner.data.audit.record({ actor: owner.actor, action: 'knowledge.item_deleted', entityType: 'knowledge_item', entityId: itemId });
}

export async function itemCounts(owner: OwnerContext) {
  return owner.data.items.counts();
}

export async function listSources(owner: OwnerContext): Promise<KnowledgeSource[]> {
  return owner.data.sources.list();
}

export async function createSource(owner: OwnerContext, input: unknown): Promise<KnowledgeSource> {
  const values = parseInput(sourceInputSchema, input);
  const source = await owner.data.sources.create(values);
  await owner.data.audit.record({ actor: owner.actor, action: 'knowledge.source_created', entityType: 'knowledge_source', entityId: source.id });
  return source;
}

export async function deleteSource(owner: OwnerContext, id: unknown): Promise<void> {
  const sourceId = parseId(id, 'Source');
  if (!(await owner.data.sources.remove(sourceId))) throw new ActionError('not_found', 'Source not found');
  await owner.data.audit.record({ actor: owner.actor, action: 'knowledge.source_deleted', entityType: 'knowledge_source', entityId: sourceId });
}

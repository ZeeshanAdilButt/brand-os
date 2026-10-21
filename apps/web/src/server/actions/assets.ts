import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AssetRejectedError, cleanFilename, inspectImage } from '../assets/inspect';
import { NotFoundError } from '../data/scope';
import type { Asset } from '../db/schema';
import { newStorageKey, type StorageAdapter } from '../storage';
import { ActionError, parseId, parseInput, type OwnerContext } from './owner';

const uploadMetaSchema = z.object({
  articleId: z.uuid().nullable().default(null),
  alt: z.string().trim().max(300).default(''),
});

/** What the browser needs to show and reference an uploaded file. */
export interface AssetView {
  id: string;
  filename: string;
  mime: string;
  size: number;
  alt: string;
  /** Where the authenticated route serves it, for the browser to display. */
  url: string;
  /** The reference to put in Markdown. The renderer turns it into `url`. */
  markdown: string;
  createdAt: Date;
}

export function assetUrl(id: string): string {
  return `/api/assets/${id}`;
}

export function toAssetView(asset: Asset): AssetView {
  const alt = asset.alt || asset.filename.replace(/\.[a-z0-9]+$/i, '');
  return {
    id: asset.id,
    filename: asset.filename,
    mime: asset.mime,
    size: asset.size,
    alt: asset.alt,
    url: assetUrl(asset.id),
    markdown: `![${alt.replace(/[[\]]/g, '')}](asset:${asset.id})`,
    createdAt: asset.createdAt,
  };
}

/**
 * Store an uploaded image for this owner. The type comes from the bytes (never the name or the
 * claimed type), the storage key is generated here, and an identical file the owner already holds
 * is reused instead of stored twice.
 */
export async function uploadAsset(
  owner: OwnerContext,
  storage: StorageAdapter,
  file: { bytes: Uint8Array; filename: string },
  meta: unknown = {},
): Promise<{ asset: AssetView; created: boolean }> {
  const { articleId, alt } = parseInput(uploadMetaSchema, meta);
  let inspected;
  try {
    inspected = inspectImage(file.bytes);
  } catch (err) {
    if (err instanceof AssetRejectedError) {
      throw new ActionError(err.reason === 'too_large' ? 'too_large' : 'invalid', err.message, { file: err.message });
    }
    throw err;
  }
  const sha256 = createHash('sha256').update(file.bytes).digest('hex');
  const existing = await owner.data.assets.findBySha(sha256);
  if (existing) {
    if (articleId) await ensureArticle(owner, articleId);
    return { asset: toAssetView(existing), created: false };
  }

  const storageKey = newStorageKey(owner.ownerId, inspected.extension);
  await storage.put(storageKey, file.bytes);
  try {
    const { asset, created } = await owner.data.assets.create({
      articleId,
      filename: cleanFilename(file.filename),
      mime: inspected.mime,
      size: file.bytes.length,
      sha256,
      storageKey,
      alt,
    });
    if (!created) await storage.delete(storageKey);
    else await owner.data.audit.record({ actor: owner.actor, action: 'asset.uploaded', entityType: 'asset', entityId: asset.id });
    return { asset: toAssetView(asset), created };
  } catch (err) {
    await storage.delete(storageKey);
    if (err instanceof NotFoundError) throw new ActionError('not_found', 'Article not found');
    throw err;
  }
}

async function ensureArticle(owner: OwnerContext, articleId: string): Promise<void> {
  if (!(await owner.data.articles.get(articleId))) throw new ActionError('not_found', 'Article not found');
}

/** The bytes and facts for serving an asset. Another owner's id is "not found", like any missing one. */
export async function readAsset(
  owner: OwnerContext,
  storage: StorageAdapter,
  id: unknown,
): Promise<{ asset: Asset; bytes: Uint8Array }> {
  const asset = await owner.data.assets.get(parseId(id, 'Asset'));
  if (!asset) throw new ActionError('not_found', 'Asset not found');
  const bytes = await storage.get(asset.storageKey);
  if (!bytes) throw new ActionError('not_found', 'Asset not found');
  return { asset, bytes };
}

export async function listAssets(owner: OwnerContext, articleId?: unknown): Promise<AssetView[]> {
  const rows = await owner.data.assets.list(articleId === undefined ? undefined : parseId(articleId, 'Article'));
  return rows.map(toAssetView);
}

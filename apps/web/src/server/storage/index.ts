import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config';

/**
 * Where uploaded files live. The database row (`assets`) says whose a file is and what it is; this
 * adapter only stores and returns bytes under an opaque key the server generated.
 *
 * Seam, not an implementation: a hosted deployment on a platform without a persistent disk needs an
 * object-store adapter (S3 or compatible) that implements this same interface. None is built yet, so
 * hosted mode today keeps files on the server's disk under DATA_DIR. See DECISIONS.md.
 */
export interface StorageAdapter {
  readonly kind: 'filesystem';
  /** Store bytes under a key made by `newStorageKey`. Never overwrites: keys are unique. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** The bytes, or null when the key holds nothing. */
  get(key: string): Promise<Uint8Array | null>;
  /** Remove the bytes. Removing a missing key is not an error. */
  delete(key: string): Promise<void>;
}

export const STORAGE_EXTENSIONS = ['png', 'jpg', 'gif', 'webp', 'svg'] as const;
export type StorageExtension = (typeof STORAGE_EXTENSIONS)[number];

export class InvalidStorageKeyError extends Error {
  constructor() {
    super('Invalid storage key');
    this.name = 'InvalidStorageKeyError';
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** owner id / file id . extension: the only shape a key can have, so there is nothing to traverse. */
const KEY_PATTERN = new RegExp(`^(${UUID})/(${UUID})\\.(${STORAGE_EXTENSIONS.join('|')})$`);

/** A fresh key. Built from the owner id and a random id; no part of an upload's name is used. */
export function newStorageKey(ownerId: string, extension: StorageExtension): string {
  return `${ownerId.toLowerCase()}/${randomUUID()}.${extension}`;
}

/** Throws unless the key is exactly the shape `newStorageKey` produces. */
export function assertStorageKey(key: string): { ownerId: string; id: string; extension: StorageExtension } {
  const match = KEY_PATTERN.exec(key);
  if (!match) throw new InvalidStorageKeyError();
  return { ownerId: match[1]!, id: match[2]!, extension: match[3] as StorageExtension };
}

/**
 * Files on local disk under `<root>`. A key is validated against the strict pattern and then
 * resolved; the resolved path must still sit inside the root, which also covers a root reached
 * through a link. User input never reaches path.join: only a validated, server-made key does.
 */
export function createFilesystemStorage(root: string): StorageAdapter {
  const base = path.resolve(root);

  function locate(key: string): string {
    assertStorageKey(key);
    const full = path.resolve(base, ...key.split('/'));
    const relative = path.relative(base, full);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new InvalidStorageKeyError();
    return full;
  }

  return {
    kind: 'filesystem',
    async put(key, bytes) {
      const target = locate(key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // 'wx': a key is written once. A collision (astronomically unlikely) fails instead of replacing.
      await fs.writeFile(target, bytes, { flag: 'wx' });
    },
    async get(key) {
      const target = locate(key);
      try {
        return new Uint8Array(await fs.readFile(target));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async delete(key) {
      const target = locate(key);
      await fs.rm(target, { force: true });
    },
  };
}

const globalForStorage = globalThis as typeof globalThis & { __cphStorage?: Map<string, StorageAdapter> };

/** The adapter for this configuration. One per data directory per process. */
export function getStorage(config: Pick<AppConfig, 'dataDir'>): StorageAdapter {
  const cache = (globalForStorage.__cphStorage ??= new Map());
  const root = path.resolve(config.dataDir, 'assets');
  let adapter = cache.get(root);
  if (!adapter) {
    adapter = createFilesystemStorage(root);
    cache.set(root, adapter);
  }
  return adapter;
}

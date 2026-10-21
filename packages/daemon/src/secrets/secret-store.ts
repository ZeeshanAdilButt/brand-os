import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { PlatformId } from '@cph/core';
import type { Repos } from '../db/repos.js';
import { MASTER_KEY_NAME, MasterKeyInvalid, MasterKeyMissing, type KeyStore } from './keystore.js';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A stored credential failed authentication or is malformed. The message never carries secret material. */
export class SecretDecryptError extends Error {
  constructor(platform: string, account: string) {
    super(`Stored credential for ${platform}/${account} failed authentication (tampered, corrupted, or encrypted under another master key).`);
    this.name = 'SecretDecryptError';
  }
}

/**
 * Envelope-encrypted credential storage: AES-256-GCM under a master key that lives only in the
 * keystore, a fresh random 12-byte IV per write, and `platform/account` bound in as additional
 * authenticated data so a ciphertext cannot be moved to another row. Ciphertext, IV and tag go to
 * the `credentials` table through `repos`.
 *
 * The master key is never re-created implicitly. `put` and `get` throw `MasterKeyMissing` when it
 * is gone (even if no row exists, so a wiped keyring is loud); only `ensureMasterKey()`, called by
 * `cph install`, creates one.
 */
export class SecretStore {
  readonly #ks: KeyStore;
  readonly #repos: Repos;

  constructor(ks: KeyStore, repos: Repos) {
    this.#ks = ks;
    this.#repos = repos;
  }

  /** Creates the master key if absent; leaves an existing valid one untouched. */
  ensureMasterKey(): void {
    ensureMasterKey(this.#ks);
  }

  put(platform: PlatformId, account: string, secret: Record<string, string>): void {
    const key = this.#masterKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(platform, account));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
    this.#repos.credentials.put({ platform, account, ciphertext, iv, tag: cipher.getAuthTag() });
  }

  get(platform: PlatformId, account: string): Record<string, string> | null {
    const key = this.#masterKey();
    const row = this.#repos.credentials.get(platform, account);
    if (!row) return null;
    if (row.iv.length !== IV_BYTES || row.tag.length !== TAG_BYTES) throw new SecretDecryptError(platform, account);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(platform, account));
      decipher.setAuthTag(row.tag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
      return parseSecret(plaintext);
    } catch {
      throw new SecretDecryptError(platform, account);
    }
  }

  delete(platform: PlatformId, account: string): void {
    this.#repos.credentials.delete(platform, account);
  }

  /** `cph revoke-all`: removes every stored credential. The master key stays, so reconnecting just works. */
  wipeAll(): void {
    this.#repos.credentials.deleteAll();
  }

  #masterKey(): Buffer {
    const encoded = this.#ks.get(MASTER_KEY_NAME);
    if (encoded === null) throw new MasterKeyMissing();
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_BYTES) throw new MasterKeyInvalid();
    return key;
  }
}

/**
 * Creates the master key in `ks` if absent; leaves an existing valid one untouched (a malformed one
 * throws `MasterKeyInvalid`). `cph install` calls this directly, before any database exists.
 */
export function ensureMasterKey(ks: KeyStore): void {
  const encoded = ks.get(MASTER_KEY_NAME);
  if (encoded === null) {
    ks.set(MASTER_KEY_NAME, randomBytes(KEY_BYTES).toString('base64'));
    return;
  }
  if (Buffer.from(encoded, 'base64').length !== KEY_BYTES) throw new MasterKeyInvalid();
}

function aad(platform: string, account: string): Buffer {
  return Buffer.from(`cph:credential:v1\0${platform}\0${account}`, 'utf8');
}

function parseSecret(plaintext: string): Record<string, string> {
  const value: unknown = JSON.parse(plaintext);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
  for (const field of Object.values(value)) if (typeof field !== 'string') throw new Error('not a string map');
  return value as Record<string, string>;
}

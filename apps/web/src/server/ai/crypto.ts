import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config';
import { MEMORY_DATA_DIR } from '../db/client';

/**
 * Encryption at rest for provider API keys: AES-256-GCM with a fresh 12-byte IV per value.
 *
 * The master key is, in order of preference:
 *  1. derived from APP_SECRET (HKDF-SHA256), the only option in hosted mode;
 *  2. in local mode, 32 random bytes in `secret.key` inside DATA_DIR, created on first use with
 *     owner-only permissions (mode 0600; on Windows the inherited permissions are replaced with the
 *     current user's);
 *  3. in tests with an in-memory database, a random key that lives as long as the process.
 *
 * Each ciphertext is bound to its row: the owner id and provider id are authenticated data, so a
 * value copied into another row or another tenant fails to decrypt.
 */

const VERSION = 'v1';
const KEY_FILE = 'secret.key';
const HKDF_SALT = 'brand-os/provider-keys/v1';

export class SecretUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretUnavailableError';
  }
}

const cache = new Map<string, Buffer>();

/** Restrict a file to the current user. Best effort: a failure is not fatal because the folder is the user's own. */
function restrictToCurrentUser(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* not supported on this file system */
  }
  if (process.platform === 'win32' && process.env.USERNAME) {
    try {
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(R,W)`], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* icacls missing or refused: the default user-profile permissions still apply */
    }
  }
}

function readOrCreateKeyFile(dataDir: string): Buffer {
  const dir = path.resolve(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, KEY_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fresh = randomBytes(32);
      fs.writeFileSync(file, fresh.toString('base64'), { flag: 'wx', mode: 0o600 });
      restrictToCurrentUser(file);
      return fresh;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
      if (existing.length === 32) return existing;
      throw new SecretUnavailableError(`${KEY_FILE} in the data folder is damaged. Restore it from a backup; saved keys cannot be read without it.`);
    }
  }
  throw new SecretUnavailableError('Could not create the encryption key file.');
}

/** The 32-byte master key for this configuration. Throws SecretUnavailableError with a message that says what to set. */
export function masterKey(config: Pick<AppConfig, 'mode' | 'appSecret' | 'dataDir'>): Buffer {
  if (config.appSecret) {
    if (config.appSecret.length < 32) throw new SecretUnavailableError('APP_SECRET must be at least 32 characters.');
    const cacheKey = `secret:${config.appSecret}`;
    let key = cache.get(cacheKey);
    if (!key) {
      key = Buffer.from(hkdfSync('sha256', config.appSecret, HKDF_SALT, 'aes-256-gcm', 32));
      cache.set(cacheKey, key);
    }
    return key;
  }
  if (config.mode === 'hosted') {
    throw new SecretUnavailableError('Saving an API key on a hosted server needs APP_SECRET (at least 32 random characters) in the server environment.');
  }
  if (config.dataDir === MEMORY_DATA_DIR) {
    let key = cache.get('memory');
    if (!key) {
      key = randomBytes(32);
      cache.set('memory', key);
    }
    return key;
  }
  const cacheKey = `file:${path.resolve(config.dataDir)}`;
  let key = cache.get(cacheKey);
  if (!key) {
    key = readOrCreateKeyFile(config.dataDir);
    cache.set(cacheKey, key);
  }
  return key;
}

const aad = (ownerId: string, providerId: string) => Buffer.from(`brand-os:${ownerId}:${providerId}`, 'utf8');

/** Encrypt a key for one provider row of one owner. */
export function encryptKey(plain: string, key: Buffer, ownerId: string, providerId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(ownerId, providerId));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join('.');
}

/** Decrypt a stored key. Throws on a wrong master key, a changed value or a value moved to another row. */
export function decryptKey(stored: string, key: Buffer, ownerId: string, providerId: string): string {
  const [version, iv, tag, body] = stored.split('.');
  if (version !== VERSION || !iv || !tag || !body) throw new SecretUnavailableError('The saved key is in an unknown format.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad(ownerId, providerId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretUnavailableError('The saved key could not be decrypted. The encryption key has changed, so enter the provider key again.');
  }
}

/** Test seam: forget cached master keys. */
export function clearMasterKeyCache(): void {
  cache.clear();
}

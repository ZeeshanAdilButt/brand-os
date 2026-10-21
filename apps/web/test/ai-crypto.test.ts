import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearMasterKeyCache, decryptKey, encryptKey, masterKey, SecretUnavailableError } from '../src/server/ai/crypto';
import { MEMORY_DATA_DIR } from '../src/server/db/client';
import { tempDirWithSpace } from './helpers';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const OTHER_OWNER = '00000000-0000-4000-8000-0000000000b2';
const PROVIDER = '00000000-0000-4000-8000-0000000000c3';
const OTHER_PROVIDER = '00000000-0000-4000-8000-0000000000d4';
const plain = () => `fk_${randomBytes(16).toString('hex')}`;
const SECRET = 'a-long-test-secret-0123456789abcdefghijklmnopqrstuv';

afterEach(() => clearMasterKeyCache());

describe('provider key encryption', () => {
  it('round-trips, and a stored value reveals nothing', () => {
    const key = masterKey({ mode: 'hosted', appSecret: SECRET, dataDir: MEMORY_DATA_DIR });
    const value = plain();
    const stored = encryptKey(value, key, OWNER, PROVIDER);
    expect(stored.startsWith('v1.')).toBe(true);
    expect(stored).not.toContain(value);
    expect(decryptKey(stored, key, OWNER, PROVIDER)).toBe(value);
  });

  it('uses a fresh IV every time', () => {
    const key = masterKey({ mode: 'hosted', appSecret: SECRET, dataDir: MEMORY_DATA_DIR });
    const value = plain();
    expect(encryptKey(value, key, OWNER, PROVIDER)).not.toBe(encryptKey(value, key, OWNER, PROVIDER));
  });

  it('refuses a value moved to another provider row or another owner', () => {
    const key = masterKey({ mode: 'hosted', appSecret: SECRET, dataDir: MEMORY_DATA_DIR });
    const stored = encryptKey(plain(), key, OWNER, PROVIDER);
    expect(() => decryptKey(stored, key, OWNER, OTHER_PROVIDER)).toThrow(SecretUnavailableError);
    expect(() => decryptKey(stored, key, OTHER_OWNER, PROVIDER)).toThrow(SecretUnavailableError);
  });

  it('refuses a tampered value and a wrong master key', () => {
    const key = masterKey({ mode: 'hosted', appSecret: SECRET, dataDir: MEMORY_DATA_DIR });
    const stored = encryptKey(plain(), key, OWNER, PROVIDER);
    const parts = stored.split('.');
    const flipped = [...parts.slice(0, 3), Buffer.from(randomBytes(8)).toString('base64url')].join('.');
    expect(() => decryptKey(flipped, key, OWNER, PROVIDER)).toThrow(SecretUnavailableError);
    const other = masterKey({ mode: 'hosted', appSecret: `${SECRET}-changed`, dataDir: MEMORY_DATA_DIR });
    expect(() => decryptKey(stored, other, OWNER, PROVIDER)).toThrow(/could not be decrypted/);
    expect(() => decryptKey('garbage', key, OWNER, PROVIDER)).toThrow(SecretUnavailableError);
  });
});

describe('the master key', () => {
  it('comes from APP_SECRET when set, and the same secret gives the same key', () => {
    const a = masterKey({ mode: 'local', appSecret: SECRET, dataDir: MEMORY_DATA_DIR });
    clearMasterKeyCache();
    const b = masterKey({ mode: 'hosted', appSecret: SECRET, dataDir: MEMORY_DATA_DIR });
    expect(a.equals(b)).toBe(true);
    expect(a).toHaveLength(32);
  });

  it('rejects a short APP_SECRET and refuses to run hosted without one', () => {
    expect(() => masterKey({ mode: 'hosted', appSecret: 'short', dataDir: MEMORY_DATA_DIR })).toThrow(/at least 32/);
    expect(() => masterKey({ mode: 'hosted', appSecret: undefined, dataDir: MEMORY_DATA_DIR })).toThrow(/needs APP_SECRET/);
  });

  it('is generated into the data folder in local mode, kept across restarts, and never changes', () => {
    const dir = tempDirWithSpace('cph key ');
    try {
      const first = masterKey({ mode: 'local', appSecret: undefined, dataDir: dir });
      const file = path.join(dir, 'secret.key');
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).not.toContain(first.toString('hex'));
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      clearMasterKeyCache();
      const again = masterKey({ mode: 'local', appSecret: undefined, dataDir: dir });
      expect(again.equals(first)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a damaged key file instead of silently replacing it', () => {
    const dir = tempDirWithSpace('cph key ');
    try {
      fs.writeFileSync(path.join(dir, 'secret.key'), 'not a key');
      expect(() => masterKey({ mode: 'local', appSecret: undefined, dataDir: dir })).toThrow(/damaged/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.js';
import { createRepos, type Repos } from '../src/db/repos.js';
import { issueApiToken, MasterKeyInvalid, MasterKeyMissing, MemoryKeyStore, WindowsKeyStore } from '../src/secrets/keystore.js';
import { redact } from '../src/secrets/redact.js';
import { SecretDecryptError, SecretStore } from '../src/secrets/secret-store.js';

/** CPU-heavy tests (long loops, simulated days) get room on a loaded machine; the default 5 s stays for the rest. */
const HEAVY_TEST_MS = 60_000;

const T0 = '2026-10-19T10:00:00.000Z';

let db: Db;
let repos: Repos;
let ks: MemoryKeyStore;
let store: SecretStore;

beforeEach(() => {
  db = openDb(':memory:');
  repos = createRepos(db, { now: () => T0 });
  ks = new MemoryKeyStore();
  store = new SecretStore(ks, repos);
});

afterEach(() => {
  db.close();
});

const PLAINTEXT = 'not-a-real-credential-hunter2-0123456789';

describe('SecretStore', () => {
  it('round-trips a multi-field secret', () => {
    store.ensureMasterKey();
    const secret = { apiKey: PLAINTEXT, orgId: 'org_123', note: 'ρ and 🙂' };
    store.put('devto', 'default', secret);
    expect(store.get('devto', 'default')).toEqual(secret);
  });

  it('returns null for an account that was never stored', () => {
    store.ensureMasterKey();
    expect(store.get('devto', 'nobody')).toBeNull();
  });

  it('overwrites on a second put and deletes on request', () => {
    store.ensureMasterKey();
    store.put('devto', 'default', { apiKey: 'one' });
    store.put('devto', 'default', { apiKey: 'two' });
    expect(store.get('devto', 'default')).toEqual({ apiKey: 'two' });
    store.delete('devto', 'default');
    expect(store.get('devto', 'default')).toBeNull();
  });

  it('keeps the plaintext out of every stored column', () => {
    store.ensureMasterKey();
    store.put('devto', 'default', { apiKey: PLAINTEXT });
    const row = repos.credentials.get('devto', 'default');
    expect(row).toBeDefined();
    for (const column of [row!.ciphertext, row!.iv, row!.tag]) {
      expect(column.includes(Buffer.from(PLAINTEXT))).toBe(false);
      expect(column.toString('base64').includes(Buffer.from(PLAINTEXT).toString('base64').slice(0, 12))).toBe(false);
    }
    expect(row!.iv).toHaveLength(12);
    expect(row!.tag).toHaveLength(16);
  });

  it('uses a fresh random 12-byte IV for every write', () => {
    store.ensureMasterKey();
    const ivs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      store.put('devto', 'default', { apiKey: PLAINTEXT });
      ivs.add(repos.credentials.get('devto', 'default')!.iv.toString('hex'));
    }
    expect(ivs.size).toBe(50);
  });

  it('throws when one byte of the tag is tampered with', () => {
    store.ensureMasterKey();
    store.put('devto', 'default', { apiKey: PLAINTEXT });
    const row = repos.credentials.get('devto', 'default')!;
    const tag = Buffer.from(row.tag);
    tag[0] = (tag[0] ?? 0) ^ 0x01;
    repos.credentials.put({ platform: 'devto', account: 'default', ciphertext: row.ciphertext, iv: row.iv, tag });
    expect(() => store.get('devto', 'default')).toThrow(SecretDecryptError);
  });

  it('throws when the ciphertext or the iv is tampered with', () => {
    store.ensureMasterKey();
    store.put('devto', 'default', { apiKey: PLAINTEXT });
    const row = repos.credentials.get('devto', 'default')!;

    const ciphertext = Buffer.from(row.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0x80;
    repos.credentials.put({ platform: 'devto', account: 'default', ciphertext, iv: row.iv, tag: row.tag });
    expect(() => store.get('devto', 'default')).toThrow(SecretDecryptError);

    const iv = Buffer.from(row.iv);
    iv[11] = (iv[11] ?? 0) ^ 0x01;
    repos.credentials.put({ platform: 'devto', account: 'default', ciphertext: row.ciphertext, iv, tag: row.tag });
    expect(() => store.get('devto', 'default')).toThrow(SecretDecryptError);
  });

  it('rejects a truncated tag instead of accepting a weaker check', () => {
    store.ensureMasterKey();
    store.put('devto', 'default', { apiKey: PLAINTEXT });
    const row = repos.credentials.get('devto', 'default')!;
    repos.credentials.put({
      platform: 'devto',
      account: 'default',
      ciphertext: row.ciphertext,
      iv: row.iv,
      tag: row.tag.subarray(0, 4),
    });
    expect(() => store.get('devto', 'default')).toThrow(SecretDecryptError);
  });

  it('refuses a ciphertext moved to another platform or account', () => {
    store.ensureMasterKey();
    store.put('devto', 'default', { apiKey: PLAINTEXT });
    const row = repos.credentials.get('devto', 'default')!;
    repos.credentials.put({ platform: 'linkedin', account: 'default', ciphertext: row.ciphertext, iv: row.iv, tag: row.tag });
    repos.credentials.put({ platform: 'devto', account: 'other', ciphertext: row.ciphertext, iv: row.iv, tag: row.tag });
    expect(() => store.get('linkedin', 'default')).toThrow(SecretDecryptError);
    expect(() => store.get('devto', 'other')).toThrow(SecretDecryptError);
  });

  it('does not put the secret into a decrypt error message', () => {
    store.ensureMasterKey();
    store.put('devto', 'default', { apiKey: PLAINTEXT });
    const row = repos.credentials.get('devto', 'default')!;
    const tag = Buffer.from(row.tag);
    tag[0] = (tag[0] ?? 0) ^ 0x01;
    repos.credentials.put({ platform: 'devto', account: 'default', ciphertext: row.ciphertext, iv: row.iv, tag });
    try {
      store.get('devto', 'default');
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(PLAINTEXT);
    }
  });

  it('fails to decrypt under a different master key', () => {
    store.ensureMasterKey();
    store.put('devto', 'default', { apiKey: PLAINTEXT });
    const other = new MemoryKeyStore();
    const otherStore = new SecretStore(other, repos);
    otherStore.ensureMasterKey();
    expect(() => otherStore.get('devto', 'default')).toThrow(SecretDecryptError);
  });

  describe('master key', () => {
    it('throws MasterKeyMissing on put, get and never silently re-creates it', () => {
      expect(() => store.put('devto', 'default', { apiKey: 'x' })).toThrow(MasterKeyMissing);
      expect(() => store.get('devto', 'default')).toThrow(MasterKeyMissing);
      expect(ks.get('master-key')).toBeNull();
      expect(repos.credentials.get('devto', 'default')).toBeUndefined();
    });

    it('throws MasterKeyMissing when the key vanishes after secrets were stored', () => {
      store.ensureMasterKey();
      store.put('devto', 'default', { apiKey: PLAINTEXT });
      ks.delete('master-key');
      expect(() => store.get('devto', 'default')).toThrow(MasterKeyMissing);
      expect(ks.get('master-key')).toBeNull();
    });

    it('ensureMasterKey creates 32 random bytes as base64 and is idempotent', () => {
      store.ensureMasterKey();
      const first = ks.get('master-key');
      expect(first).not.toBeNull();
      expect(Buffer.from(first!, 'base64')).toHaveLength(32);
      store.ensureMasterKey();
      expect(ks.get('master-key')).toBe(first);
      const second = new MemoryKeyStore();
      new SecretStore(second, repos).ensureMasterKey();
      expect(second.get('master-key')).not.toBe(first);
    });

    it('rejects a master key of the wrong length instead of using it', () => {
      ks.set('master-key', randomBytes(16).toString('base64'));
      expect(() => store.ensureMasterKey()).toThrow(MasterKeyInvalid);
      expect(() => store.put('devto', 'default', { apiKey: 'x' })).toThrow(MasterKeyInvalid);
    });

    it('does not put the master key into error messages', () => {
      const bad = randomBytes(16).toString('base64');
      ks.set('master-key', bad);
      try {
        store.get('devto', 'default');
        expect.unreachable();
      } catch (err) {
        expect(String((err as Error).message)).not.toContain(bad);
      }
    });
  });

  it('wipeAll removes every credential but keeps the master key', () => {
    store.ensureMasterKey();
    store.put('devto', 'default', { apiKey: 'a' });
    store.put('linkedin', 'me', { token: 'b' });
    const key = ks.get('master-key');
    store.wipeAll();
    expect(store.get('devto', 'default')).toBeNull();
    expect(store.get('linkedin', 'me')).toBeNull();
    expect(ks.get('master-key')).toBe(key);
  });
});

describe('issueApiToken', () => {
  it('stores a prefixed 32-byte base64url token under api-token:<scope> and returns it', () => {
    const token = issueApiToken(ks, 'mcp');
    expect(ks.get('api-token:mcp')).toBe(token);
    expect(token).toMatch(/^cph_mcp_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token.slice('cph_mcp_'.length), 'base64url')).toHaveLength(32);
    expect(ks.get('api-token:cli')).toBeNull();
    expect(issueApiToken(ks, 'cli')).toMatch(/^cph_cli_[A-Za-z0-9_-]{43}$/);
  });

  it('issues distinct tokens per scope and per call (rotation)', () => {
    const mcp = issueApiToken(ks, 'mcp');
    const cli = issueApiToken(ks, 'cli');
    expect(mcp).not.toBe(cli);
    const rotated = issueApiToken(ks, 'mcp');
    expect(rotated).not.toBe(mcp);
    expect(ks.get('api-token:mcp')).toBe(rotated);
  });
});

describe('MemoryKeyStore', () => {
  it('gets, sets, overwrites and deletes', () => {
    expect(ks.get('a')).toBeNull();
    ks.set('a', '1');
    ks.set('a', '2');
    expect(ks.get('a')).toBe('2');
    ks.delete('a');
    expect(ks.get('a')).toBeNull();
    ks.delete('a');
  });
});

describe('redact', () => {
  const MASK = '[REDACTED]';

  it('hides an api-key header value', () => {
    const out = redact('api-key: abcdefghijklmnopqrstuvwxyz');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(out).toContain(MASK);
    expect(out).toContain('api-key');
  });

  it('hides api key variants, query strings and JSON fields', () => {
    for (const input of [
      'X-API-Key: s3cr3tvalue',
      'api_key=s3cr3tvalue&x=1',
      'GET /v1/me?apikey=s3cr3tvalue HTTP/1.1',
      '{"api-key":"s3cr3tvalue","other":"fine"}',
      "{'access_token': 's3cr3tvalue'}",
      'password: s3cr3tvalue',
      'client_secret=s3cr3tvalue',
    ]) {
      const out = redact(input);
      expect(out, input).not.toContain('s3cr3tvalue');
      expect(out, input).toContain(MASK);
    }
    expect(redact('{"api-key":"s3cr3tvalue","other":"fine"}')).toContain('"other":"fine"');
    expect(redact('api_key=s3cr3tvalue&x=1')).toContain('&x=1');
  });

  it('hides Bearer tokens and Authorization headers', () => {
    expect(redact('Bearer abc.def-ghi_jkl')).toBe(`Bearer ${MASK}`);
    expect(redact('bearer s3cr3t')).toBe(`bearer ${MASK}`);
    expect(redact('the bearer of bad news')).toBe('the bearer of bad news');
    const header = redact('Authorization: Bearer abc123 trailing');
    expect(header).not.toContain('abc123');
    expect(header).toBe(`Authorization: Bearer ${MASK}`);
    const basic = redact('authorization: Basic bm90LWEtcmVhbC1jcmVk');
    expect(basic).not.toContain('bm90LWEtcmVhbC1jcmVk');
  });

  it('masks the credential after any Authorization scheme, not the scheme word', () => {
    const bot = redact('Authorization: Bot not-a-real-bot-credential-0123456789abcdef');
    expect(bot).toBe(`Authorization: Bot ${MASK}`);
    const oauth = redact('Authorization: OAuth abcDEF123ghiJKL456');
    expect(oauth).toBe(`Authorization: OAuth ${MASK}`);
    expect(redact('authorization: Digest username="u", realm="r", response="abcdef0123"')).toBe(`authorization: Digest ${MASK}`);
    expect(redact('Authorization: rawtoken123')).toBe(`Authorization: ${MASK}`);
    expect(redact('{"Authorization":"Bot not-a-real-bot-credential-0123456789abcdef","other":"fine"}')).toBe(`{"Authorization":"Bot ${MASK}","other":"fine"}`);
    expect(redact('Authorization: Token abc\nnext line stays')).toBe(`Authorization: Token ${MASK}\nnext line stays`);
  });

  it('always masks our own API tokens, including digit-free ones', { timeout: HEAVY_TEST_MS }, () => {
    for (let i = 0; i < 20_000; i++) {
      const token = issueApiToken(ks, i % 2 === 0 ? 'mcp' : 'cli');
      expect(redact(`sent ${token} ok`), token).toBe(`sent ${MASK} ok`);
    }
    // A 43-char random part with no digit and a trailing '-' still matches the prefixed shape.
    expect(redact('cph_mcp_aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoP-')).toBe(MASK);
  });

  it('masks digit-free mixed-case random runs but not camelCase identifiers', () => {
    expect(redact('k aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPq k')).toBe(`k ${MASK} k`);
    expect(redact('createWindowsHelloVerifierFactoryImplementation')).toBe('createWindowsHelloVerifierFactoryImplementation');
    expect(redact('PublishingApprovalConsumerTransactionBoundary')).toBe('PublishingApprovalConsumerTransactionBoundary');
  });

  it('masks long base64url and hex runs wherever they appear', () => {
    const token = 'q7Zk2mX9vB4nR1tYw8LcD5hJ3sPfA6gUeN0oIiKxVyM';
    const out = redact(`calling with ${token} now`);
    expect(out).not.toContain(token);
    expect(out).toBe(`calling with ${MASK} now`);

    const hex = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
    expect(redact(`key=${hex}`)).not.toContain(hex);
    expect(redact(`<${hex}>`)).toBe(`<${MASK}>`);
  });

  it('masks a base64 master key including its padding and slashes', () => {
    for (let i = 0; i < 200; i++) {
      const key = randomBytes(32).toString('base64');
      const out = redact(`master ${key} end`);
      expect(out, key).toBe(`master ${MASK} end`);
    }
  });

  it('masks JWT-shaped tokens', () => {
    // Built at runtime so no provider-shaped literal sits in the source.
    const b64 = (text: string): string => Buffer.from(text).toString('base64url');
    const header = b64('{"alg":"HS256","typ":"JWT"}');
    const signature = b64('not-a-real-signature-0123456789abcdef');
    const jwt = `${header}.${b64('{"sub":"fake-user-0001","name":"Test Only"}')}.${signature}`;
    const out = redact(`token seen ${jwt}`);
    expect(out).not.toContain(header);
    expect(out).not.toContain(signature);
    expect(out).toBe(`token seen ${MASK}.${MASK}.${MASK}`);
  });

  it('masks every occurrence, not just the first', () => {
    const a = 'q7Zk2mX9vB4nR1tYw8LcD5hJ3sPfA6gUeN0oIiKxVyM';
    const b = 'Hh3_Gg4-Ff5Ee6Dd7Cc8Bb9Aa0Zz1Yy2Xx3Ww4Vv5U';
    const out = redact(`${a} and ${b}`);
    expect(out).toBe(`${MASK} and ${MASK}`);
  });

  it('leaves plain words, slugs, paths, dates and ids alone', () => {
    for (const input of [
      'publishing is disabled; nothing was sent',
      'internationalization-and-localization-considerations',
      'prometheus-cardinality-explained',
      'Internationalizationandlocalizationconsiderationsfordevelopers',
      'createWindowsHelloVerifierFactoryImplementation',
      'https://www.example-blog.dev/blog/prometheus-cardinality-explained',
      'C:\\Users\\you\\AppData\\Local\\content-powerhouse\\cph.db',
      'C:/Users/the owner/AppData/Local/Temp/claude/D--Projects---Community/scratchpad',
      '2026-10-19T10:00:00.000Z',
      '6f9619ff-8b86-d011-b42d-00c04fc964ff',
      'tokens: 3 of 10 used',
      'draft 42 hash abc123',
      '',
    ]) {
      expect(redact(input), input).toBe(input);
    }
  });

  it('may mask a 40-char git SHA (accepted false positive)', () => {
    const sha = 'bcd5e17a2f9c4b8e1d3a6f7c0b5e9d2a4c8f1e3b';
    expect(redact(`commit ${sha}`)).toBe(`commit ${MASK}`);
  });

  it('is idempotent', () => {
    const once = redact('api-key: abcdefghijklmnopqrstuvwxyz and q7Zk2mX9vB4nR1tYw8LcD5hJ3sPfA6gUeN0oIiKxVyM');
    expect(redact(once)).toBe(once);
  });
});

// Opt-in: touches the real Windows Credential Manager, but only under a throwaway service name,
// and always deletes what it wrote. Never uses the `content-powerhouse` service.
describe.skipIf(process.env['CPH_KEYRING_IT'] !== '1')('WindowsKeyStore (real Credential Manager)', () => {
  it('sets, gets, overwrites and deletes an entry under a throwaway service', () => {
    const service = `content-powerhouse-test-${randomBytes(6).toString('hex')}`;
    expect(service).not.toBe('content-powerhouse');
    const real = new WindowsKeyStore(service);
    const name = 'it-entry';
    try {
      expect(real.get(name)).toBeNull();
      real.set(name, 'value-one');
      expect(real.get(name)).toBe('value-one');
      real.set(name, 'value-two');
      expect(real.get(name)).toBe('value-two');
      real.delete(name);
      expect(real.get(name)).toBeNull();
      real.delete(name);
    } finally {
      real.delete(name);
    }
  });
});

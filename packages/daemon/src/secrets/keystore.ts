import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

/** The production service name in Windows Credential Manager. Tests must never use it. */
export const KEYRING_SERVICE = 'content-powerhouse';
/** Keystore entry that holds the base64 master key (32 random bytes). */
export const MASTER_KEY_NAME = 'master-key';

/**
 * A tiny synchronous secret vault: the master key and the per-install API tokens live here, never
 * in SQLite, the repo, `.env` or a log. `get` returns `null` for an entry that does not exist;
 * `delete` of a missing entry is a no-op.
 */
export interface KeyStore {
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete(name: string): void;
}

/** The master key is absent. Only `cph install` (via `SecretStore.ensureMasterKey`) may create it. */
export class MasterKeyMissing extends Error {
  constructor() {
    super('Master key is missing from the keystore. Run `cph install` to create it; stored credentials need reconnecting.');
    this.name = 'MasterKeyMissing';
  }
}

/** The master key exists but is not 32 bytes of base64. The value is never put in the message. */
export class MasterKeyInvalid extends Error {
  constructor() {
    super('Master key in the keystore is malformed (expected 32 bytes, base64).');
    this.name = 'MasterKeyInvalid';
  }
}

/** In-memory keystore for tests. */
export class MemoryKeyStore implements KeyStore {
  readonly #entries = new Map<string, string>();

  get(name: string): string | null {
    return this.#entries.get(name) ?? null;
  }

  set(name: string, value: string): void {
    this.#entries.set(name, value);
  }

  delete(name: string): void {
    this.#entries.delete(name);
  }
}

/** The subset of `@napi-rs/keyring`'s `Entry` that this module uses. */
interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deleteCredential(): boolean;
}
type KeyringEntryCtor = new (service: string, username: string) => KeyringEntry;

/**
 * Windows Credential Manager via `@napi-rs/keyring` (`Entry(service, name)`). The native binding
 * loads on construction, so importing this module (or running unit tests) never touches the
 * credential store. Pass a different `service` only for the opt-in integration test.
 */
export class WindowsKeyStore implements KeyStore {
  readonly #Entry: KeyringEntryCtor;
  readonly #service: string;

  constructor(service: string = KEYRING_SERVICE) {
    const require = createRequire(import.meta.url);
    this.#Entry = (require('@napi-rs/keyring') as { Entry: KeyringEntryCtor }).Entry;
    this.#service = service;
  }

  get(name: string): string | null {
    return new this.#Entry(this.#service, name).getPassword();
  }

  set(name: string, value: string): void {
    new this.#Entry(this.#service, name).setPassword(value);
  }

  delete(name: string): void {
    new this.#Entry(this.#service, name).deleteCredential();
  }
}

export type ApiTokenScope = 'mcp' | 'cli';

/**
 * Mints a fresh API token for `scope`, `cph_<scope>_<32 random bytes as 43 base64url chars>`, stores
 * it as `api-token:<scope>` (a second call rotates it) and returns it. The `cph_<scope>_` prefix
 * gives `redact` a shape it can always recognise, whatever the random part looks like. The caller
 * decides where, if anywhere, to show it.
 */
export function issueApiToken(ks: KeyStore, scope: ApiTokenScope): string {
  const token = `cph_${scope}_${randomBytes(32).toString('base64url')}`;
  ks.set(`api-token:${scope}`, token);
  return token;
}

import { decryptKey, encryptKey, masterKey, SecretUnavailableError } from '../ai/crypto';
import type { AppConfig } from '../config';

/**
 * What a connection stores, sealed with the same AES-256-GCM scheme as every other key (bound to the owner and the
 * row). The three connectors that publish (DEV.to, Hashnode, the personal site) keep a plain key for the adapters;
 * every other connector stores a bundle: the field values it was given and, for a sign-in, the tokens. A bundle is
 * recognised by its first characters, so an old plain key still opens.
 */

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | undefined;
  tokenType?: string | undefined;
  /** ISO time the access token stops working, if the platform said. */
  expiresAt?: string | null | undefined;
  obtainedAt: string;
  /** Names of the scopes granted. */
  scopes?: string[] | undefined;
}

export interface Bundle {
  cphBundle: 1;
  /** Everything the person typed for this connector (secret and not). */
  fields: Record<string, string>;
  tokens?: TokenSet | undefined;
  /** For a per-instance platform: the client registered on the person's server for this connection. */
  client?: { clientId: string; clientSecret: string; instance: string } | undefined;
}

const MARK = '{"cphBundle":1';

export function encodeBundle(bundle: Omit<Bundle, 'cphBundle'>): string {
  return JSON.stringify({ cphBundle: 1, ...bundle });
}

/** A stored value as a bundle. A plain key becomes `{ fields: { <primary>: key } }`. */
export function decodeBundle(plain: string, primaryField: string): Bundle {
  if (plain.startsWith(MARK)) {
    try {
      const parsed = JSON.parse(plain) as Bundle;
      return { cphBundle: 1, fields: parsed.fields ?? {}, tokens: parsed.tokens, client: parsed.client };
    } catch {
      throw new SecretUnavailableError('The saved connection could not be read. Connect again.');
    }
  }
  return { cphBundle: 1, fields: { [primaryField]: plain } };
}

/** The one string a publishing adapter sends as its key: the access token of a sign-in, or the primary field. */
export function unwrapSecret(plain: string): string {
  if (!plain.startsWith(MARK)) return plain;
  try {
    const parsed = JSON.parse(plain) as Bundle;
    return parsed.tokens?.accessToken ?? Object.values(parsed.fields ?? {})[0] ?? '';
  } catch {
    return plain;
  }
}

export function seal(config: Pick<AppConfig, 'mode' | 'appSecret' | 'dataDir'>, plain: string, ownerId: string, rowId: string): string {
  return encryptKey(plain, masterKey(config), ownerId, rowId);
}

export function open(config: Pick<AppConfig, 'mode' | 'appSecret' | 'dataDir'>, stored: string, ownerId: string, rowId: string): string {
  return decryptKey(stored, masterKey(config), ownerId, rowId);
}

/** Every secret string in a bundle, for redaction. */
export function secretsOf(bundle: Bundle, secretFieldIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of secretFieldIds) {
    const v = bundle.fields[id];
    if (v) out.push(v);
  }
  if (bundle.tokens?.accessToken) out.push(bundle.tokens.accessToken);
  if (bundle.tokens?.refreshToken) out.push(bundle.tokens.refreshToken);
  if (bundle.client?.clientSecret) out.push(bundle.client.clientSecret);
  return out;
}

/** The last four characters shown as a hint. Empty for a sign-in, which has no key to show. */
export function hintOf(value: string | undefined): string {
  return value && value.length >= 8 ? value.slice(-4) : '';
}

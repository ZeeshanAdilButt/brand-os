import type { Protocol, ProviderKind, Trust } from '../../lib/ai';
import { isBlockedAddress, isLocalHostname, parseIp } from '../import/netguard';

/**
 * Rules about the address a provider talks to. Two separate questions:
 *  - trust: does the text stay on this machine or network (`local`) or leave it (`external`)?
 *  - allowed: may the server make this request at all? (Hosted servers must not be turned into a way
 *    to reach private networks or the machine they run on.)
 */

/** Whether an address is on this machine or a private network, by its name or IP literal. */
export function isPrivateTarget(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (parseIp(host)) return isBlockedAddress(host);
  return isLocalHostname(host);
}

/**
 * Trust is decided here, from facts, and never typed in by the person: only a `local` provider whose
 * address is on this machine or a private network keeps text local. Everything else, including a
 * "local" provider pointed at a public address, is external.
 */
export function deriveTrust(kind: ProviderKind, baseUrl: string | null): Trust {
  if (kind !== 'local' || !baseUrl) return 'external';
  try {
    return isPrivateTarget(new URL(baseUrl)) ? 'local' : 'external';
  } catch {
    return 'external';
  }
}

export interface TargetCheck {
  ok: boolean;
  message: string | null;
  /** The address normalized: scheme and host in lower case, no trailing slash, no query or fragment. */
  baseUrl: string | null;
}

/**
 * Check and normalize a base URL the person typed. In hosted mode a `local` provider is not possible (the
 * server cannot reach a model on someone's machine, and an address the server can reach is not theirs to
 * point at), and an OpenAI-compatible address must be https on a public name.
 */
export function checkTarget(input: { mode: 'local' | 'hosted'; kind: ProviderKind; protocol: Protocol | null; baseUrl: string }): TargetCheck {
  let url: URL;
  try {
    url = new URL(input.baseUrl.trim());
  } catch {
    return { ok: false, message: 'Enter a full address, for example http://localhost:11434/v1.', baseUrl: null };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'The address must start with http:// or https://.', baseUrl: null };
  }
  if (url.username || url.password) {
    return { ok: false, message: 'Put the key in the key field, not in the address.', baseUrl: null };
  }
  if (input.mode === 'hosted') {
    if (input.kind === 'local') {
      return { ok: false, message: 'A hosted server cannot reach a model on your machine. Use an API key provider, or run Brand OS locally.', baseUrl: null };
    }
    if (url.protocol !== 'https:') return { ok: false, message: 'On a hosted server the address must use https://.', baseUrl: null };
    if (isPrivateTarget(url)) return { ok: false, message: 'That address points at a private network, which a hosted server will not call.', baseUrl: null };
    if (url.port && url.port !== '443' && url.port !== '8443') return { ok: false, message: 'On a hosted server use port 443 or 8443.', baseUrl: null };
  }
  const normalized = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  return { ok: true, message: null, baseUrl: normalized };
}

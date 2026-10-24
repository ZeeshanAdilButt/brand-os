import type { ConnectorDefinition, ConnectionState } from './types';
import { STATE_LABELS } from './types';

/**
 * What the list and the drawer say about one connector, computed from facts the server already has. No network:
 * the persisted result of the last check, the token's expiry date and whether the app credentials exist. Pure, so the
 * browser and the tests use the same function.
 */

export interface ConnectionFacts {
  /** The stored connection, or null. Never carries a secret. */
  connection: {
    status: 'connected' | 'needs_reconnect' | 'error' | 'unchecked';
    tokenExpiresAt: string | null;
    /** True when a refresh token is held, so an expired access token is renewed rather than lost. */
    renewable: boolean;
    lastErrorCode: string | null;
    scopesGranted: string[];
  } | null;
  /** The person's own OAuth app is saved (or the host provides one). */
  hasApp: boolean;
  now: Date;
}

export interface StateView {
  state: ConnectionState;
  label: string;
  /** One quiet line under the name. */
  detail: string;
  /** Whole days until the token stops working, when it has a date. */
  expiresInDays: number | null;
  /** The list shows a quiet Reconnect button. */
  reconnect: boolean;
}

const DAY = 86_400_000;
const AUTH_CODES = new Set(['rejected', 'expired', 'revoked', 'denied']);

const view = (state: ConnectionState, detail: string, extra: Partial<StateView> = {}): StateView => ({ state, label: STATE_LABELS[state], detail, expiresInDays: null, reconnect: state === 'needs_reconnect', ...extra });

export function connectionState(def: ConnectorDefinition, facts: ConnectionFacts, shared?: ConnectionFacts): StateView {
  if (def.kind === 'manual_only') {
    const state = def.states.includes('planned') ? 'planned' : 'manual';
    return view(state, state === 'planned' ? 'Directory only. Nothing to connect yet.' : 'No API. The app prepares it and you post it.');
  }
  if (def.verification.level === 'unverified') {
    return view('set_up', 'Not confirmed against the official documentation, so nothing is sent to the platform.');
  }
  if (def.sharesWith) {
    const base = shared ?? { connection: null, hasApp: false, now: facts.now };
    const needed = def.scopes.filter((s) => s.required).map((s) => s.name);
    if (base.connection && base.connection.status === 'connected' && needed.every((n) => base.connection!.scopesGranted.includes(n))) {
      return view('connected', 'Uses your LinkedIn sign-in.');
    }
    if (base.connection && base.connection.status === 'connected') return view('needs_reconnect', 'Reconnect LinkedIn and allow posting.');
    return view(base.hasApp ? 'needs_key' : 'set_up', 'Connect LinkedIn first. Video uses the same sign-in.');
  }

  const connection = facts.connection;
  if (!connection) {
    const signIn = def.kind === 'oauth2_code_pkce' || Boolean(def.device && def.kind === 'device_flow');
    if (signIn && def.oauth && !def.oauth.perInstance && !facts.hasApp) return view('set_up', 'Register your own app once, then sign in.');
    return view('needs_key', signIn ? 'Ready. Sign in with the platform to connect.' : 'Add the key to connect.');
  }

  const expiry = connection.tokenExpiresAt ? new Date(connection.tokenExpiresAt) : null;
  const expiresInDays = expiry ? Math.floor((expiry.getTime() - facts.now.getTime()) / DAY) : null;
  const expired = expiry ? expiry.getTime() <= facts.now.getTime() : false;
  const lost = connection.status === 'needs_reconnect' || (connection.lastErrorCode !== null && AUTH_CODES.has(connection.lastErrorCode));

  if (lost) return view('needs_reconnect', def.kind === 'oauth2_code_pkce' ? 'Sign in again to keep it working.' : 'The platform no longer accepts the saved key. Replace it.', { expiresInDays });
  if (expired && !connection.renewable) {
    return view('needs_reconnect', def.kind === 'oauth2_code_pkce' ? 'The sign-in has expired. Sign in again.' : 'The saved key has expired. Replace it.', { expiresInDays });
  }
  if (connection.status === 'error') return view('connected', 'The last check could not reach the platform. Try Test again.', { expiresInDays });
  if (connection.status === 'unchecked') return view('connected', 'Saved. Not checked yet.', { expiresInDays });
  if (expiresInDays !== null && !connection.renewable && expiresInDays <= 7) {
    return view('connected', expiresInDays <= 0 ? 'Expires today. Reconnect soon.' : `Expires in ${expiresInDays} day${expiresInDays === 1 ? '' : 's'}. Reconnect soon.`, { expiresInDays, reconnect: true });
  }
  return view('connected', expiresInDays !== null && !connection.renewable ? `Valid for ${expiresInDays} more days.` : 'Checked and working.', { expiresInDays });
}

/** The groups on the "Connect all that are ready" overview. */
export type OverviewGroup = 'connected' | 'ready' | 'owner' | 'manual';

export function overviewGroup(state: ConnectionState): OverviewGroup {
  if (state === 'connected') return 'connected';
  if (state === 'needs_key' || state === 'needs_reconnect') return 'ready';
  if (state === 'set_up') return 'owner';
  return 'manual';
}

import type { ConnectionDTO } from '../publishing';
import type { ConnectorId } from './ids';
import type { ConnectionState } from './types';

/** What the screens receive for one connector. No secret, no ciphertext, no token, ever. */

export interface DeviceFlowDTO {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalSec: number;
}

export interface AppDTO {
  /** A client id is saved (or the host provides the app). */
  saved: boolean;
  /** Last four characters of the saved client id. Empty when the host provides it. */
  hint: string;
  source: 'saved' | 'host' | null;
}

export interface ConnectorViewDTO {
  id: ConnectorId;
  state: ConnectionState;
  label: string;
  detail: string;
  expiresInDays: number | null;
  /** A quiet Reconnect prompt is shown. */
  reconnect: boolean;
  connection: ConnectionDTO | null;
  /** The OAuth app for the redirect sign-in. */
  app: AppDTO;
  /** The client for the code sign-in (device flow). */
  deviceApp: AppDTO;
  /** The exact redirect address to register, or null when the connector does not redirect. */
  redirectUri: string | null;
  /** A code sign-in is waiting for the person. */
  device: DeviceFlowDTO | null;
  /** A key saved before the connection framework existed, kept until the person removes it. */
  legacyKeyHint: string | null;
  /** This connection publishes through an adapter (DEV.to, Hashnode, the personal site). */
  publishes: boolean;
}

export interface ConnectResult {
  ok: boolean;
  message: string;
  view: ConnectorViewDTO;
  /** The platform's name for the account, on success. */
  account?: string;
}

export interface StartOAuthResult {
  flowId: string;
  authorizeUrl: string;
  redirectUri: string;
  expiresAt: string;
}

export type DevicePollResult =
  | { state: 'pending'; intervalSec: number; retryAfterSec: number }
  | { state: 'connected'; view: ConnectorViewDTO; account: string }
  | { state: 'expired' | 'denied'; message: string };

export interface DisconnectResult {
  /** `provider`: the platform revoked the grant. `manual`: the stored secret is deleted and the person finishes on the platform. */
  revoked: 'provider' | 'manual';
  message: string;
  steps: string[];
  view: ConnectorViewDTO;
}

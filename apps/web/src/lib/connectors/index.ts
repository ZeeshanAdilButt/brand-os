import { KEY_DEFINITIONS } from './defs-keys';
import { MANUAL_DEFINITIONS } from './defs-manual';
import { OAUTH_DEFINITIONS } from './defs-oauth';
import { CONNECTOR_IDS, isConnectorId, type ConnectorId } from './ids';
import { connectorSchema, type ConnectorDefinition } from './types';

export * from './ids';
export * from './types';

/**
 * THE connector registry: one validated definition for every platform in the directory. Parsing here means a
 * malformed definition stops the app from loading, and the test suite checks that every directory entry has exactly
 * one definition.
 */
function load(): Record<ConnectorId, ConnectorDefinition> {
  const all = [...KEY_DEFINITIONS, ...OAUTH_DEFINITIONS, ...MANUAL_DEFINITIONS];
  const out = {} as Record<ConnectorId, ConnectorDefinition>;
  for (const raw of all) {
    const parsed = connectorSchema.parse(raw);
    if (out[parsed.id]) throw new Error(`Connector ${parsed.id} is defined twice.`);
    out[parsed.id] = parsed;
  }
  const missing = CONNECTOR_IDS.filter((id) => !out[id]);
  if (missing.length > 0) throw new Error(`Connectors are missing for: ${missing.join(', ')}`);
  return out;
}

export const CONNECTORS: Readonly<Record<ConnectorId, ConnectorDefinition>> = Object.freeze(load());

export const CONNECTOR_LIST: readonly ConnectorDefinition[] = CONNECTOR_IDS.map((id) => CONNECTORS[id]);

export function connectorFor(id: string): ConnectorDefinition | null {
  return isConnectorId(id) ? CONNECTORS[id] : null;
}

/** A connection is made by signing in with the platform (a redirect or a code). */
export function isOAuthConnector(def: ConnectorDefinition): boolean {
  return def.kind === 'oauth2_code_pkce' && !def.sharesWith;
}

/** The connector supports a device code sign-in, as its main way or as an alternative. */
export function hasDeviceFlow(def: ConnectorDefinition): boolean {
  return Boolean(def.device);
}

/** Pasted values, as opposed to signing in with the platform. */
export function takesFields(def: ConnectorDefinition): boolean {
  return def.fields.length > 0 && def.kind !== 'manual_only';
}

/** Whether the owner supplies their own OAuth app (client id and secret) for this connector. */
export function needsOwnApp(def: ConnectorDefinition): boolean {
  return (isOAuthConnector(def) && !def.oauth?.perInstance) || Boolean(def.device);
}

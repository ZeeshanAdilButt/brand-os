import type { ConnectorDefinition } from '../../lib/connectors';
import { endpointUrl, type ConnectEnv } from './env';
import { call, ConnectFailure, jsonOf, safeMessage } from './request';
import { readTokens, tokenPost, type AppCredentials, type TokenResponse } from './oauth';

/**
 * The OAuth device authorization grant (RFC 8628) as GitHub and Google offer it: the app asks for a short code, the
 * person types it on the platform's own page, and the app polls until the platform hands over a token. The platform
 * sets the polling interval and may ask to slow down. Nothing here is stored; the caller keeps the device code
 * encrypted and records the next time it may poll.
 */

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSec: number;
  intervalSec: number;
}

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Ask the platform for a code. Scopes are space separated, as RFC 8628 says. */
export async function requestDeviceCode(env: ConnectEnv, def: ConnectorDefinition, creds: AppCredentials, scopes: string[]): Promise<DeviceCode> {
  const url = def.endpoints.device;
  if (!def.device || !url) throw new ConnectFailure('unexpected', `${def.name} does not offer a sign-in with a code.`);
  const secrets = [creds.clientSecret ?? ''];
  const body = new URLSearchParams({ client_id: creds.clientId, scope: scopes.join(' ') });
  const res = await call(env, endpointUrl(env, def, url), { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }, { secrets });
  const parsed = jsonOf(res) ?? Object.fromEntries(new URLSearchParams(res.text.trim()).entries());
  const error = typeof parsed.error === 'string' ? parsed.error : null;
  if (error === 'device_flow_disabled') throw new ConnectFailure('bad_input', `Turn on the device flow in your ${def.name} app settings first.`);
  if (error === 'invalid_client' || error === 'incorrect_client_credentials') throw new ConnectFailure('rejected', `${def.name} did not accept the app's client ID. Check it in your app settings.`);
  if (error === 'rate_limit_exceeded') throw new ConnectFailure('rate_limited', `${def.name} says too many codes were asked for. Wait a few minutes and try again.`);
  if (error || res.status >= 400) throw new ConnectFailure('bad_input', safeMessage(`${def.name} refused the request${error ? ` (${error})` : ''}.`, secrets), { httpStatus: res.status });
  const deviceCode = typeof parsed.device_code === 'string' ? parsed.device_code : null;
  const userCode = typeof parsed.user_code === 'string' ? parsed.user_code : null;
  const verification = [parsed.verification_uri, parsed.verification_url].find((v): v is string => typeof v === 'string');
  if (!deviceCode || !userCode || !verification) throw new ConnectFailure('unexpected', `${def.name} answered the request for a code with something this app could not read.`);
  // The page the person is sent to must be a plain https address: it becomes a link in the drawer.
  if (!/^https:\/\/[^\s]+$/.test(verification)) throw new ConnectFailure('unexpected', `${def.name} answered with a verification address this app will not open.`);
  if (!/^[A-Za-z0-9 _-]{4,20}$/.test(userCode)) throw new ConnectFailure('unexpected', `${def.name} answered with a code this app could not read.`);
  const expires = Number(parsed.expires_in);
  const interval = Number(parsed.interval);
  return {
    deviceCode,
    userCode,
    verificationUri: verification,
    expiresInSec: Number.isFinite(expires) && expires > 0 ? Math.min(expires, 900) : 900,
    intervalSec: Number.isFinite(interval) && interval > 0 ? interval : 5,
  };
}

export type DevicePoll =
  | { state: 'pending'; intervalSec: number }
  | { state: 'slow_down'; intervalSec: number }
  | { state: 'done'; tokens: TokenResponse }
  | { state: 'expired' }
  | { state: 'denied' };

/** Ask once whether the person has entered the code. */
export async function pollDevice(env: ConnectEnv, def: ConnectorDefinition, creds: AppCredentials, deviceCode: string, intervalSec: number): Promise<DevicePoll> {
  if (!def.device || !def.endpoints.token) throw new ConnectFailure('unexpected', `${def.name} does not offer a sign-in with a code.`);
  const secrets = [deviceCode, creds.clientSecret ?? ''];
  const answer = await tokenPost(env, def.name, {
    url: endpointUrl(env, def, def.endpoints.token),
    params: { grant_type: GRANT_TYPE, device_code: deviceCode },
    client: { id: creds.clientId, secret: def.device.sendClientSecret ? creds.clientSecret : null, auth: def.device.sendClientSecret ? 'body' : 'none' },
    secrets,
  });
  const error = typeof answer.body.error === 'string' ? answer.body.error : null;
  if (error === 'authorization_pending') return { state: 'pending', intervalSec };
  if (error === 'slow_down') return { state: 'slow_down', intervalSec: (typeof answer.body.interval === 'number' ? answer.body.interval : intervalSec) + (typeof answer.body.interval === 'number' ? 0 : 5) };
  if (error === 'expired_token' || error === 'token_expired') return { state: 'expired' };
  if (error === 'access_denied') return { state: 'denied' };
  if (error === 'device_flow_disabled') throw new ConnectFailure('bad_input', `Turn on the device flow in your ${def.name} app settings first.`);
  return { state: 'done', tokens: readTokens(def.name, answer, secrets) };
}

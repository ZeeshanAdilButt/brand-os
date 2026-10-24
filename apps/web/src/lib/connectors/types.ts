import { z } from 'zod';
import { CONNECTOR_IDS } from './ids';

/**
 * One typed, validated shape for how a platform is connected. Definitions are plain data (no functions) so the
 * browser, the server and the docs read the same facts; the server-only part (`validate`) lives in
 * `server/connect/validators` and is keyed by the same id. Every definition is parsed with `connectorSchema` when
 * the registry loads, so a malformed one fails the build, not a user.
 */

export const AUTH_KINDS = ['api_key', 'token_with_scopes', 'oauth2_code_pkce', 'device_flow', 'app_password', 'webhook_url', 'bot_token', 'site_credentials', 'manual_only'] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

export const AUTH_KIND_LABELS: Record<AuthKind, string> = {
  api_key: 'API key',
  token_with_scopes: 'Token with limited access',
  oauth2_code_pkce: 'Sign in with the platform (OAuth)',
  device_flow: 'Sign in with a code (device flow)',
  app_password: 'App password',
  webhook_url: 'Webhook address',
  bot_token: 'Bot token',
  site_credentials: 'Your site and its credentials',
  manual_only: 'Manual only',
};

/** What a connection can show. The persisted status (connected, needs reconnecting, error) is turned into these by `connectionState`. */
export const CONNECTION_STATES = ['connected', 'needs_key', 'needs_reconnect', 'set_up', 'manual', 'planned'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const STATE_LABELS: Record<ConnectionState, string> = {
  connected: 'Connected',
  needs_key: 'Needs key',
  needs_reconnect: 'Needs reconnect',
  set_up: 'Set up',
  manual: 'Manual',
  planned: 'Planned',
};

const text = (min = 3) => z.string().trim().min(min).max(600);
const httpsUrl = z.url().refine((v) => v.startsWith('https://'), 'must be https');

export const fieldSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-zA-Z0-9]{1,30}$/),
    label: text(2),
    /** A secret is a password field, never echoed, stored encrypted, never returned. */
    secret: z.boolean(),
    required: z.boolean(),
    /** What it looks like, in words: "40 characters, no spaces". */
    formatHint: text(),
    placeholder: z.string().max(80).optional(),
    /** Where to get it, in plain words. */
    help: text(),
    /** Deep link to the platform's own page for it. */
    getItUrl: httpsUrl.optional(),
    /** A regular expression source the value must match, checked in the browser and on the server. */
    pattern: z.string().max(200).optional(),
    /** `url` is a site address the person owns (normalized and, when hosted, restricted to public https). */
    kind: z.enum(['text', 'secret', 'url']),
  })
  .strict()
  .refine((f) => (f.kind === 'secret') === f.secret, 'secret fields use kind "secret" and nothing else does');
export type ConnectorField = z.infer<typeof fieldSchema>;

export const stepSchema = z
  .object({
    title: text(),
    body: text(),
    linkUrl: httpsUrl.optional(),
    linkLabel: text().optional(),
  })
  .strict()
  .refine((s) => (s.linkUrl === undefined) === (s.linkLabel === undefined), 'a link needs a label');
export type ConnectorStep = z.infer<typeof stepSchema>;

export const scopeSchema = z.object({ name: text(2), reason: text(), required: z.boolean() }).strict();
export type ConnectorScope = z.infer<typeof scopeSchema>;

const endpointMap = z
  .object({
    authorize: httpsUrl.optional(),
    token: httpsUrl.optional(),
    device: httpsUrl.optional(),
    revoke: httpsUrl.optional(),
    /** Origin of the platform's API. Per-person hosts (an instance, a site) are not here: they come from a field. */
    api: httpsUrl.optional(),
  })
  .strict();

export const validationSchema = z
  .object({
    method: z.enum(['GET', 'POST']),
    /** The one request `validate()` makes. A template: `{field}` is a field value. */
    url: z.string().min(8).max(300),
    /** What the account name is read from, in words. */
    account: text(),
    /** Always true: a check never changes anything on the platform. */
    readOnly: z.literal(true),
    note: z.string().max(400).optional(),
  })
  .strict();

export const tokenSchema = z
  .object({
    /** How long an access token lasts, in words, or null when it does not expire. */
    lifetime: z.string().max(120).nullable(),
    /** `refresh_token`: renewed server-side. `exchange`: renewed by trading the live token (Threads). `reconsent`: the person signs in again. `none`: it does not expire. */
    renewal: z.enum(['none', 'refresh_token', 'exchange', 'reconsent']),
    note: text(),
  })
  .strict();

export const revokeSchema = z
  .object({
    /** The platform's official revoke call, when one exists. Disconnect calls it, then deletes the stored secret. */
    provider: z.object({ method: z.enum(['POST', 'DELETE']), note: text() }).strict().nullable(),
    /** What the person does on the platform to take the access away completely. */
    manualSteps: z.array(text()).min(1),
    manualUrl: httpsUrl.optional(),
  })
  .strict();

export const oauthSchema = z
  .object({
    /** `always`: send an S256 challenge. `never`: the platform does not document PKCE, so the client secret and a bound state protect the exchange. */
    pkce: z.enum(['always', 'never']),
    /** How the app authenticates at the token endpoint: HTTP Basic, in the body, or not at all (a public client). */
    clientAuth: z.enum(['basic', 'body', 'none']),
    scopeSeparator: z.enum([' ', ',']),
    extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
    /** The platform needs a different client for each server (Mastodon): the app is registered on the instance first. */
    perInstance: z.boolean().optional(),
    /** Threads trades the first token for a 60 day one right after sign-in. */
    longLivedExchange: z.boolean().optional(),
    /** The redirect rule the platform states, shown beside the redirect address. */
    redirectNote: text(),
    /** Steps to create the app on the platform, once. */
    appSteps: z.array(stepSchema).min(2),
    appUrl: httpsUrl,
  })
  .strict();

export const deviceSchema = z
  .object({
    /** The client id comes from the person's own app; the secret is not needed. */
    note: text(),
    scopes: z.array(scopeSchema).min(1),
    appSteps: z.array(stepSchema).min(2),
    appUrl: httpsUrl,
    /** Google also wants the client secret when polling. */
    sendClientSecret: z.boolean(),
  })
  .strict();

export const manualSchema = z
  .object({
    /** Why there is nothing to connect. */
    reason: text(10),
    /** What the person does instead. */
    handoff: z.array(text()).min(1),
    openUrl: httpsUrl,
    openLabel: text(),
  })
  .strict();

export const verificationSchema = z
  .object({
    level: z.enum(['verified', 'unverified']),
    checkedOn: z.literal('2026-10-24'),
    sources: z.array(httpsUrl).min(1),
    /** Statements that could not be confirmed on an official page. */
    unverified: z.array(text()),
  })
  .strict();

export const connectorSchema = z
  .object({
    id: z.enum(CONNECTOR_IDS),
    name: z.string().trim().min(1).max(80),
    kind: z.enum(AUTH_KINDS),
    /** Another way to connect the same platform (GitHub: a fine-grained token, or a device code). */
    alternative: z.enum(['device_flow']).optional(),
    /** The platform shares another connector's account (LinkedIn video uses the LinkedIn sign-in). */
    sharesWith: z.enum(CONNECTOR_IDS).optional(),
    /** One line for the list: what connecting gives. */
    summary: text(10),
    fields: z.array(fieldSchema).max(6),
    steps: z.array(stepSchema).max(8),
    scopes: z.array(scopeSchema).max(12),
    endpoints: endpointMap,
    validation: validationSchema.optional(),
    tokens: tokenSchema.optional(),
    revoke: revokeSchema.optional(),
    oauth: oauthSchema.optional(),
    device: deviceSchema.optional(),
    manual: manualSchema.optional(),
    /** The states this connector can show. */
    states: z.array(z.enum(CONNECTION_STATES)).min(1),
    verification: verificationSchema,
    /** The person's address is called by the server, so a hosted server restricts it to public https. */
    userHost: z.boolean().optional(),
    /** The platform's own documentation for this connection. */
    docsUrl: httpsUrl,
  })
  .strict()
  .superRefine((def, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message: `${def.id}: ${message}` });
    if (def.kind === 'manual_only') {
      if (!def.manual) fail('a manual connector needs its reason and handoff');
      if (def.fields.length > 0 || def.validation || def.oauth || def.device || def.tokens) fail('a manual connector has nothing to validate or store');
      if (def.states.some((s) => s !== 'manual' && s !== 'planned')) fail('a manual connector shows Manual or Planned only');
      return;
    }
    if (def.manual) fail('only a manual connector has a manual block');
    if (def.steps.length < 2) fail('needs at least two ordered steps');
    if (!def.validation) fail('needs a validate request');
    if (!def.revoke) fail('needs revoke or disconnect steps');
    if (!def.tokens) fail('needs token expiry and renewal rules');
    if (def.sharesWith) {
      if (def.oauth || def.device || def.fields.length > 0) fail('a connector that shares another sign-in has no app, device or field of its own');
    } else {
      if (def.kind === 'oauth2_code_pkce' && !def.oauth) fail('an OAuth connector needs its oauth block');
      if (def.kind === 'oauth2_code_pkce' && !(def.endpoints.authorize && def.endpoints.token) && !def.oauth?.perInstance) fail('an OAuth connector needs authorize and token endpoints');
      if (def.kind !== 'oauth2_code_pkce' && def.fields.length === 0) fail('needs at least one field');
    }
    if ((def.kind === 'oauth2_code_pkce' || def.kind === 'token_with_scopes' || def.kind === 'device_flow') && def.scopes.length === 0) fail('needs its least-privilege scopes with reasons');
    if (def.alternative === 'device_flow' && !def.device) fail('a device-flow alternative needs its device block');
    const states = new Set(def.states);
    if (def.verification.level === 'unverified') {
      if (def.verification.unverified.length === 0) fail('an unverified connector says what is unverified');
      if (states.has('connected')) fail('an unverified connector cannot show Connected');
      if (!states.has('set_up')) fail('an unverified connector shows Set up');
    } else if (!states.has('connected')) {
      fail('a verified connector can show Connected');
    }
  });

export type ConnectorDefinition = z.infer<typeof connectorSchema>;

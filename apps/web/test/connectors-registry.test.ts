import { describe, expect, it } from 'vitest';
import { CONNECTOR_IDS, CONNECTOR_LIST, CONNECTORS, connectorFor, connectorSchema, hasDeviceFlow, isOAuthConnector, needsOwnApp, AUTH_KINDS, STATE_LABELS, type ConnectorDefinition } from '../src/lib/connectors';
import { connectionState, overviewGroup, type ConnectionFacts } from '../src/lib/connectors/state';
import { DIRECTORY } from '../src/lib/directory';

const NOW = new Date('2026-10-24T10:00:00Z');
const facts = (patch: Partial<ConnectionFacts> = {}): ConnectionFacts => ({ connection: null, hasApp: false, now: NOW, ...patch });
const connection = (patch: Partial<NonNullable<ConnectionFacts['connection']>> = {}): NonNullable<ConnectionFacts['connection']> => ({
  status: 'connected',
  tokenExpiresAt: null,
  renewable: false,
  lastErrorCode: null,
  scopesGranted: [],
  ...patch,
});

describe('the connector registry covers the whole directory', () => {
  it('has exactly one definition for every directory entry and nothing else', () => {
    expect(CONNECTOR_LIST.map((d) => d.id).sort()).toEqual(DIRECTORY.map((e) => e.id).sort());
    expect([...CONNECTOR_IDS].sort()).toEqual(DIRECTORY.map((e) => e.id).sort());
    expect(CONNECTOR_LIST).toHaveLength(45);
  });

  it('parses every definition with the schema (it is the same check the registry runs at load)', () => {
    for (const def of CONNECTOR_LIST) expect(() => connectorSchema.parse(def), def.id).not.toThrow();
  });

  it('uses every kind that exists in the catalog, and only kinds from the list', () => {
    const kinds = new Set(CONNECTOR_LIST.map((d) => d.kind));
    for (const kind of kinds) expect(AUTH_KINDS).toContain(kind);
    for (const kind of ['api_key', 'token_with_scopes', 'oauth2_code_pkce', 'app_password', 'webhook_url', 'site_credentials', 'manual_only'] as const) expect(kinds.has(kind), kind).toBe(true);
    expect(connectorFor('nope')).toBeNull();
    expect(connectorFor('devto')?.name).toBe('DEV.to');
  });

  it('gives every connectable platform fields or a sign-in, ordered steps, scopes, a check, token rules and a way out', () => {
    for (const def of CONNECTOR_LIST.filter((d) => d.kind !== 'manual_only')) {
      expect(def.steps.length, def.id).toBeGreaterThanOrEqual(2);
      expect(def.validation?.readOnly, def.id).toBe(true);
      expect(def.tokens, def.id).toBeDefined();
      expect(def.revoke?.manualSteps.length, def.id).toBeGreaterThan(0);
      expect(def.scopes.length, def.id).toBeGreaterThan(0);
      for (const scope of def.scopes) expect(scope.reason.length, `${def.id} ${scope.name}`).toBeGreaterThan(10);
      for (const field of def.fields) {
        expect(field.formatHint.length, `${def.id}.${field.id}`).toBeGreaterThan(5);
        expect(field.help.length, `${def.id}.${field.id}`).toBeGreaterThan(5);
        if (field.pattern) expect(() => new RegExp(field.pattern!), `${def.id}.${field.id}`).not.toThrow();
        if (field.secret) expect(field.kind).toBe('secret');
      }
    }
  });

  it('puts a deep link to the platform in the key platforms (a token page or an app page)', () => {
    for (const def of CONNECTOR_LIST.filter((d) => d.kind !== 'manual_only' && !d.sharesWith && d.verification.level === 'verified')) {
      const links = [...def.fields.map((f) => f.getItUrl), ...def.steps.map((s) => s.linkUrl), def.oauth?.appUrl, def.device?.appUrl].filter(Boolean);
      expect(links.length || def.userHost, `${def.id} has a link to the platform's own page`).toBeTruthy();
    }
  });

  it('says why every manual platform has nothing to connect, and what to do instead', () => {
    const manual = CONNECTOR_LIST.filter((d) => d.kind === 'manual_only');
    expect(manual).toHaveLength(25);
    for (const def of manual) {
      expect(def.manual?.reason.length, def.id).toBeGreaterThan(30);
      expect(def.manual?.handoff.length, def.id).toBeGreaterThan(0);
      expect(def.endpoints, def.id).toEqual({});
      expect(def.validation, def.id).toBeUndefined();
    }
    for (const id of ['medium', 'substack', 'reddit', 'hackernews', 'lobsters'] as const) expect(CONNECTORS[id].kind).toBe('manual_only');
  });

  it('keeps anything unconfirmed visible: an unverified connector shows only Set up', () => {
    const unverified = CONNECTOR_LIST.filter((d) => d.kind !== 'manual_only' && d.verification.level === 'unverified');
    expect(unverified.map((d) => d.id).sort()).toEqual(['buttondown', 'product_hunt', 'slack']);
    for (const def of unverified) {
      expect(def.states).toEqual(['set_up']);
      expect(def.verification.unverified.length).toBeGreaterThan(0);
    }
    for (const def of CONNECTOR_LIST) expect(def.verification.checkedOn).toBe('2026-10-24');
  });

  it('asks for the least access: posting scopes are optional wherever posting is not built', () => {
    for (const id of ['linkedin', 'x', 'threads', 'mastodon', 'youtube'] as const) {
      const posting = CONNECTORS[id].scopes.filter((s) => /write|publish|upload|social/.test(s.name));
      expect(posting.length, id).toBeGreaterThan(0);
      for (const scope of posting) expect(scope.required, `${id} ${scope.name}`).toBe(false);
    }
    expect(CONNECTORS.youtube.scopes.find((s) => s.name.endsWith('youtube.readonly'))?.required).toBe(true);
  });

  it('describes OAuth connectors completely, and device flow where the platform has it', () => {
    const oauth = CONNECTOR_LIST.filter(isOAuthConnector);
    expect(oauth.map((d) => d.id).sort()).toEqual(['linkedin', 'mastodon', 'threads', 'x', 'youtube']);
    for (const def of oauth) {
      expect(def.oauth?.appSteps.length, def.id).toBeGreaterThanOrEqual(2);
      expect(def.oauth?.redirectNote, def.id).toBeTruthy();
      if (!def.oauth?.perInstance) expect(def.endpoints.authorize && def.endpoints.token, def.id).toBeTruthy();
    }
    expect(CONNECTOR_LIST.filter(hasDeviceFlow).map((d) => d.id).sort()).toEqual(['site', 'youtube']);
    expect(CONNECTORS.youtube.device?.sendClientSecret).toBe(true);
    expect(CONNECTORS.site.device?.sendClientSecret).toBe(false);
    expect(CONNECTORS.mastodon.oauth?.perInstance).toBe(true);
    expect(needsOwnApp(CONNECTORS.mastodon)).toBe(false);
    expect(needsOwnApp(CONNECTORS.x)).toBe(true);
    expect(CONNECTORS.linkedin.oauth?.pkce).toBe('never');
    expect(CONNECTORS.x.oauth?.pkce).toBe('always');
  });

  it('rejects malformed definitions', () => {
    const base = CONNECTORS.devto;
    const bad = (patch: Partial<ConnectorDefinition>) => connectorSchema.safeParse({ ...base, ...patch }).success;
    expect(bad({})).toBe(true);
    expect(bad({ fields: [] })).toBe(false);
    expect(bad({ steps: base.steps.slice(0, 1) })).toBe(false);
    expect(bad({ revoke: undefined })).toBe(false);
    expect(bad({ states: ['manual'] })).toBe(false);
    expect(bad({ verification: { ...base.verification, level: 'unverified' } })).toBe(false);
    expect(bad({ fields: [{ ...base.fields[0]!, secret: false }] })).toBe(false);
    expect(connectorSchema.safeParse({ ...CONNECTORS.medium, fields: base.fields }).success).toBe(false);
    expect(connectorSchema.safeParse({ ...CONNECTORS.medium, states: ['connected'] }).success).toBe(false);
  });

  it('contains no literal secrets, no em dashes and nothing but https links', () => {
    const text = JSON.stringify(CONNECTOR_LIST);
    expect(text.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(text).not.toMatch(/http:\/\/(?!127\.0\.0\.1|localhost)/);
    for (const def of CONNECTOR_LIST) {
      for (const field of def.fields) expect(field.placeholder ?? '', `${def.id}.${field.id}`).not.toMatch(/[A-Za-z0-9]{32,}/);
    }
  });
});

describe('the state a connector shows', () => {
  it('shows Manual or Planned for platforms with nothing to connect', () => {
    expect(connectionState(CONNECTORS.medium, facts()).state).toBe('manual');
    expect(connectionState(CONNECTORS.kubecon, facts()).state).toBe('planned');
    expect(connectionState(CONNECTORS.medium, facts()).label).toBe(STATE_LABELS.manual);
  });

  it('shows Set up for an unverified connector, whatever is stored', () => {
    expect(connectionState(CONNECTORS.slack, facts({ connection: connection() })).state).toBe('set_up');
  });

  it('shows Needs key for a key platform with no connection and Connected once checked', () => {
    expect(connectionState(CONNECTORS.devto, facts()).state).toBe('needs_key');
    expect(connectionState(CONNECTORS.devto, facts({ connection: connection() })).state).toBe('connected');
  });

  it('shows Set up for an OAuth platform until the app exists, then Needs key until it is connected', () => {
    expect(connectionState(CONNECTORS.x, facts()).state).toBe('set_up');
    expect(connectionState(CONNECTORS.x, facts({ hasApp: true })).state).toBe('needs_key');
    expect(connectionState(CONNECTORS.x, facts({ hasApp: true, connection: connection({ renewable: true, tokenExpiresAt: '2026-10-24T09:00:00Z' }) })).state).toBe('connected');
    expect(connectionState(CONNECTORS.mastodon, facts()).state).toBe('needs_key');
  });

  it('asks for a reconnect when a token without renewal has expired, or the platform refused the key', () => {
    const expired = connectionState(CONNECTORS.linkedin, facts({ hasApp: true, connection: connection({ tokenExpiresAt: '2026-10-23T09:00:00Z' }) }));
    expect(expired.state).toBe('needs_reconnect');
    expect(expired.reconnect).toBe(true);
    expect(connectionState(CONNECTORS.devto, facts({ connection: connection({ lastErrorCode: 'rejected' }) })).state).toBe('needs_reconnect');
    expect(connectionState(CONNECTORS.devto, facts({ connection: connection({ status: 'needs_reconnect' }) })).state).toBe('needs_reconnect');
  });

  it('warns a week ahead without taking Connected away', () => {
    const soon = connectionState(CONNECTORS.linkedin, facts({ hasApp: true, connection: connection({ tokenExpiresAt: '2026-10-29T10:00:00Z' }) }));
    expect(soon.state).toBe('connected');
    expect(soon.expiresInDays).toBe(5);
    expect(soon.reconnect).toBe(true);
    const later = connectionState(CONNECTORS.linkedin, facts({ hasApp: true, connection: connection({ tokenExpiresAt: '2026-12-20T10:00:00Z' }) }));
    expect(later.reconnect).toBe(false);
  });

  it('does not treat a network failure as a lost sign-in', () => {
    expect(connectionState(CONNECTORS.devto, facts({ connection: connection({ status: 'error', lastErrorCode: 'unreachable' }) })).state).toBe('connected');
  });

  it('LinkedIn video follows the LinkedIn sign-in and needs the posting permission', () => {
    const li = facts({ hasApp: true, connection: connection({ scopesGranted: ['openid', 'profile'], tokenExpiresAt: '2026-12-20T00:00:00Z' }) });
    expect(connectionState(CONNECTORS.linkedin_video, facts(), li).state).toBe('needs_reconnect');
    const posting = facts({ hasApp: true, connection: connection({ scopesGranted: ['openid', 'profile', 'w_member_social'] }) });
    expect(connectionState(CONNECTORS.linkedin_video, facts(), posting).state).toBe('connected');
    expect(connectionState(CONNECTORS.linkedin_video, facts(), facts()).state).toBe('set_up');
  });

  it('groups states for the overview', () => {
    expect(overviewGroup('connected')).toBe('connected');
    expect(overviewGroup('needs_key')).toBe('ready');
    expect(overviewGroup('needs_reconnect')).toBe('ready');
    expect(overviewGroup('set_up')).toBe('owner');
    expect(overviewGroup('manual')).toBe('manual');
    expect(overviewGroup('planned')).toBe('manual');
  });
});

import type { PlatformId, RouteKind } from '@cph/core';
import { errorText, type Audit } from '../audit.js';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import { activeRouteKind, type AnyRoute, type RouteRegistry } from '../routes/registry.js';
import type { Health } from '../routes/types.js';
import { redact } from '../secrets/redact.js';

/** One route's connection, as the dashboard, `cph status` and MCP `list_connections` see it. Never a secret. */
export interface ConnectionView {
  platform: PlatformId;
  route: RouteKind;
  account: string;
  /** The route new drafts for this platform use. */
  active: boolean;
  /** 'unchecked' until the first connect or probe. */
  state: Health['state'] | 'unchecked';
  who?: string;
  detail?: string;
  nextAction?: string;
  checkedAt?: string;
}

export interface ConnectionsServiceDeps {
  repos: Repos;
  routes: RouteRegistry;
  config: () => Config;
  audit: Audit;
  now: () => Date;
}

/** Health states in which the gate lets a publish through. */
const HEALTHY: ReadonlySet<Health['state']> = new Set<Health['state']>(['connected', 'expiring', 'manual_only']);
const DEFAULT_ACCOUNT = 'default';
const ACTOR = 'connections';

/** A route that keeps its last probe (Buffer): read it, never probe (the probe is metered). */
interface CachedHealthRoute {
  lastHealth(account: string): { health: Health; checkedAt: string } | undefined;
}
const hasCachedHealth = (route: AnyRoute): route is AnyRoute & CachedHealthRoute =>
  typeof (route as Partial<CachedHealthRoute>).lastHealth === 'function';

/**
 * Connection health per registered route, from cached results only, and `connect`, which hands the
 * input to the route (the route validates it and stores the secret). The input is never stored,
 * audited or returned here.
 */
export class ConnectionsService {
  readonly #deps: ConnectionsServiceDeps;

  constructor(deps: ConnectionsServiceDeps) {
    this.#deps = deps;
  }

  /** Every registered route with its last known health. Makes no request. */
  list(account = DEFAULT_ACCOUNT): ConnectionView[] {
    const config = this.#deps.config();
    return this.#deps.routes.all().map((route): ConnectionView => {
      const base = { platform: route.platform, route: route.kind, account, active: activeRouteKind(route.platform, config) === route.kind };
      const cached = this.#cached(route, account);
      if (cached === undefined) return { ...base, state: 'unchecked' };
      return { ...base, ...view(cached.health), ...(cached.checkedAt === undefined ? {} : { checkedAt: cached.checkedAt }) };
    });
  }

  /** Connects the platform's active route (or `routeKind`) with `input` (an API key, for example). */
  async connect(platform: PlatformId, input: Record<string, string>, options: { account?: string; routeKind?: RouteKind } = {}): Promise<Health> {
    const account = options.account ?? DEFAULT_ACCOUNT;
    const kind = options.routeKind ?? activeRouteKind(platform, this.#deps.config());
    const route = this.#deps.routes.get(platform, kind);
    if (route?.connect === undefined) throw new Error(`the ${kind} route for ${platform} cannot be connected`);
    let health: Health;
    try {
      health = await route.connect(account, input);
    } catch (error) {
      this.#deps.audit({ actorChannel: ACTOR, action: 'connect_failed', platform, detail: { route: kind, account, error: errorText(error) } });
      throw error;
    }
    this.#remember(route, account, health);
    this.#deps.audit({ actorChannel: ACTOR, action: 'connected', platform, detail: { route: kind, account, ...view(health) } });
    return health;
  }

  /**
   * The approval gate's `health` dependency (ruling 5). Buffer: the cached probe only (the route
   * probes once more itself right before sending). dev.to: a live `health()` call, where any throw is
   * unhealthy. Assist routes are always fine (the user posts by hand).
   */
  async gateHealth(platform: PlatformId, account: string): Promise<boolean> {
    const route = this.#deps.routes.get(platform, activeRouteKind(platform, this.#deps.config()));
    if (route === undefined) return false;
    if (hasCachedHealth(route)) return HEALTHY.has(route.lastHealth(account)?.health.state ?? 'not_configured');
    let health: Health;
    try {
      health = await route.health(account);
    } catch {
      return false;
    }
    this.#remember(route, account, health);
    return HEALTHY.has(health.state);
  }

  // ---- internals -------------------------------------------------------------------------------

  #cached(route: AnyRoute, account: string): { health: Health; checkedAt?: string } | undefined {
    if (hasCachedHealth(route)) {
      const last = route.lastHealth(account);
      if (last !== undefined) return last;
    }
    const row = this.#deps.repos.connections.get(route.platform, account);
    if (row !== undefined && row.route === route.kind) {
      const health = parseStored(row.lastHealthDetail) ?? { state: row.status as Health['state'] };
      return row.lastHealthAt === undefined ? { health } : { health, checkedAt: row.lastHealthAt };
    }
    if (route.kind === 'assist') return { health: { state: 'manual_only' } };
    return undefined;
  }

  #remember(route: AnyRoute, account: string, health: Health): void {
    this.#deps.repos.connections.upsert({
      platform: route.platform,
      account,
      route: route.kind,
      status: health.state,
      lastHealthAt: this.#deps.now().toISOString(),
      lastHealthDetail: JSON.stringify(view(health)),
    });
  }
}

/** The displayable fields of a health result, each redacted. */
function view(health: Health): Pick<ConnectionView, 'state' | 'who' | 'detail' | 'nextAction'> {
  return {
    state: health.state,
    ...(health.who === undefined ? {} : { who: redact(health.who) }),
    ...(health.detail === undefined ? {} : { detail: redact(health.detail) }),
    ...(health.nextAction === undefined ? {} : { nextAction: redact(health.nextAction) }),
  };
}

function parseStored(raw: string | undefined): Health | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<Health>;
    return typeof parsed.state === 'string' ? (parsed as Health) : undefined;
  } catch {
    return undefined;
  }
}

import type { PlatformId, RouteKind } from '@cph/core';
import type { Config } from '../config.js';
import type { Route } from './types.js';

// A registry holds routes for many payload types, so the payload parameter is erased here; each
// route still checks its own payload.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRoute = Route<any>;

const keyOf = (platform: PlatformId, kind: RouteKind): string => `${platform}/${kind}`;

/**
 * Routes by (platform, route kind). One platform can have several routes (LinkedIn through Buffer
 * and LinkedIn by hand); a draft stores which one it was made for, and `activeRouteKind` says which
 * one new drafts use.
 */
export class RouteRegistry {
  readonly #routes = new Map<string, AnyRoute>();

  constructor(routes: AnyRoute[] = []) {
    for (const route of routes) this.register(route);
  }

  register(route: AnyRoute): void {
    const key = keyOf(route.platform, route.kind);
    if (this.#routes.has(key)) throw new Error(`a ${route.kind} route for ${route.platform} is already registered`);
    this.#routes.set(key, route);
  }

  get(platform: PlatformId, kind: RouteKind): AnyRoute | undefined {
    return this.#routes.get(keyOf(platform, kind));
  }

  require(platform: PlatformId, kind: RouteKind): AnyRoute {
    const route = this.get(platform, kind);
    if (route === undefined) throw new Error(`no ${kind} route registered for ${platform}`);
    return route;
  }

  all(): AnyRoute[] {
    return [...this.#routes.values()];
  }
}

/**
 * The route new drafts for `platform` use. dev.to is always direct. LinkedIn follows
 * `platforms.linkedin.route`; with no LinkedIn config yet it is the assist route, the only one
 * that works before anything is connected (connecting Buffer writes `route: 'buffer'`).
 */
export function activeRouteKind(platform: PlatformId, config: Config): RouteKind {
  if (platform === 'linkedin') return config.platforms.linkedin?.route ?? 'assist';
  return 'direct';
}

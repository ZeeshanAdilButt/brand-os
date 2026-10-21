import type { Repos } from '../db/repos.js';
import type { PresenceVerifier } from './presence.js';

/** The `settings` key the gate reads (`checkPublishingEnabled`); 'true' or 'false', absent means off. */
export const PUBLISHING_ENABLED_KEY = 'publishing_enabled';
/** What the Hello dialog says when turning publishing on. */
export const ENABLE_PUBLISHING_PROMPT = 'Enable publishing';

const DEFAULT_ACTOR = 'dashboard_hello';

export interface PublishingDeps {
  repos: Repos;
  presence: PresenceVerifier;
  now: () => Date;
  /** The audit channel: 'dashboard_hello' (default) or 'dashboard_click' in click mode. */
  actor?: string;
}

export type SetPublishingResult = { ok: true } | { ok: false; code: 'PRESENCE_FAILED' };

/**
 * The dashboard's `POST /settings/publishing` calls this (T0.19).
 *
 * Turning publishing ON needs a presence check that returns exactly 'verified' (any other answer,
 * or a throw, leaves the setting alone and is audited). Turning it OFF never asks for presence:
 * stopping must always be possible. Both directions are audited.
 */
export async function setPublishingEnabled(deps: PublishingDeps, enabled: boolean): Promise<SetPublishingResult> {
  const { repos, presence } = deps;
  const ACTOR = deps.actor ?? DEFAULT_ACTOR;
  const at = deps.now().toISOString();

  if (!enabled) {
    repos.transaction(() => {
      repos.settings.set(PUBLISHING_ENABLED_KEY, 'false');
      repos.audit.append({ actorChannel: ACTOR, action: 'publishing_disabled', detail: { at } });
    });
    return { ok: true };
  }

  let result: string;
  try {
    result = await presence.verify(ENABLE_PUBLISHING_PROMPT);
  } catch {
    result = 'error';
  }
  if (result !== 'verified') {
    repos.audit.append({
      actorChannel: ACTOR,
      action: 'publishing_enable_refused',
      detail: { code: 'PRESENCE_FAILED', result, at },
    });
    return { ok: false, code: 'PRESENCE_FAILED' };
  }

  repos.transaction(() => {
    repos.settings.set(PUBLISHING_ENABLED_KEY, 'true');
    repos.audit.append({ actorChannel: ACTOR, action: 'publishing_enabled', detail: { presenceVerifiedAt: at } });
  });
  return { ok: true };
}

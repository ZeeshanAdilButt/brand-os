/**
 * Vocabulary for agent access (per-user API credentials). No server imports, so the settings UI can
 * use it. Labels are user-facing copy.
 */

/** What a credential may do. A credential holds a list of these; nothing is implied by another. */
export const AGENT_SCOPES = ['read', 'write_articles', 'ai_tasks'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const SCOPE_LABELS: Record<AgentScope, { label: string; hint: string }> = {
  read: {
    label: 'Read',
    hint: 'Your profile, knowledge items, articles and AI tasks. Nothing can be changed with this alone.',
  },
  write_articles: {
    label: 'Write articles',
    hint: 'Create articles and save changes to them. Every save is a new version you can restore.',
  },
  ai_tasks: {
    label: 'AI tasks',
    hint: 'Submit the result of an AI task that is waiting for your Claude Code. You still accept or reject it in the app.',
  },
};

export const CREDENTIAL_LIMITS = {
  name: 60,
  /** Credentials one person may hold (revoked ones do not count). */
  active: 20,
} as const;

/** Characters in front of every credential, so a leaked one is recognizable and scannable. */
export const CREDENTIAL_PREFIX = 'bos_';

export interface CredentialDTO {
  id: string;
  name: string;
  scopes: AgentScope[];
  /** The first few characters, so the person can tell credentials apart. Never enough to use one. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

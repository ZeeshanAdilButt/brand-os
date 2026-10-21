/**
 * AI vocabulary shared by the schema, the server and the settings and editor UI. No server imports.
 * Labels and notes are user-facing copy: they say plainly where the text goes and what is unknown.
 */

import type { TaskResult } from './ai-ops';

/** How a provider is reached. `local_cli_agent` is a reserved slot: it exists in the registry and is never selectable. */
export const PROVIDER_KINDS = ['local', 'api_key', 'claude_code_handoff', 'local_cli_agent'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** The wire format behind `local` and `api_key` providers. Hand-off and CLI providers have none. */
export const PROTOCOLS = ['openai_compatible', 'anthropic'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** Where the text goes. `local` stays on this machine or network; `external` leaves it. */
export const TRUST_LEVELS = ['local', 'external'] as const;
export type Trust = (typeof TRUST_LEVELS)[number];

export interface KindInfo {
  label: string;
  /** Can a person create one today? */
  available: boolean;
  summary: string;
  /** Capability notes shown next to the form: what is unknown, what limits apply, where data goes. */
  notes: string[];
}

export const KIND_INFO: Record<ProviderKind, KindInfo> = {
  local: {
    label: 'Local model',
    available: true,
    summary: 'Ollama, LM Studio or any server that speaks the OpenAI chat format, on this machine or your network.',
    notes: [
      'Your text goes only to the address you enter. For localhost and private network addresses it never leaves your network.',
      'Context size is not known to the app. It depends on the model and how the server is set up, so very long selections may be cut off by the server.',
      'Quality depends on the model. Small models often fail to return the strict JSON the editor needs; a failed task says so and nothing changes.',
      'No cost is estimated. Token counts are the server’s, or a rough estimate marked as such.',
    ],
  },
  api_key: {
    label: 'API key',
    available: true,
    summary: 'Your own Anthropic key, or an OpenAI-compatible service with your own key.',
    notes: [
      'The selected text and minimal article details leave this machine and go to the provider you choose, under your own account and its terms.',
      'Knowledge items are included only when they are relevant and marked as allowed for public use. A private item is sent only if you approve it for that one task, after seeing the exact text.',
      'The key is encrypted on this server, never shown again after you save it, and never written to logs.',
      'Usage is billed to you by the provider. The app counts tokens (an estimate when the provider does not report them) and never invents a cost.',
    ],
  },
  claude_code_handoff: {
    label: 'Claude Code hand-off',
    available: true,
    summary: 'Tasks wait in your inbox until your own Claude Code picks them up over MCP. The app runs nothing.',
    notes: [
      'The app makes no model call and holds no Claude login. You run Claude Code yourself, with your own plan.',
      'When Claude Code reads a task it receives the selected text and minimal article details, the same context an external provider would get.',
      'Results come back through the MCP server, are checked by the same rules as any other result, and wait for your approval.',
      'Quality and context size are whatever your Claude Code session has.',
    ],
  },
  local_cli_agent: {
    label: 'Local CLI agent',
    available: false,
    summary: 'Run a coding agent installed on your own machine, on selected text only.',
    notes: ['Reserved. This provider type is not built yet, so it cannot be selected.'],
  },
};

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  openai_compatible: 'OpenAI-compatible',
  anthropic: 'Anthropic',
};

export const TRUST_LABELS: Record<Trust, string> = {
  local: 'Stays on your machine or network',
  external: 'Leaves your machine',
};

/** Starting points for the local model form. */
export const LOCAL_PRESETS = [
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', modelHint: 'the name of a model you pulled, for example llama3.2' },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', modelHint: 'the model identifier shown in LM Studio' },
  { id: 'other', label: 'Other OpenAI-compatible server', baseUrl: '', modelHint: 'the model name the server expects' },
] as const;

/** Suggested model ids for Anthropic. A starting point only: the field is free text and never required to match. */
export const ANTHROPIC_SUGGESTED_MODELS = {
  editing: 'claude-sonnet-5-5',
  cheap: 'claude-haiku-5-5',
} as const;

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export const AI_LIMITS = {
  name: 60,
  model: 120,
  baseUrl: 500,
  apiKey: 500,
  workspaceId: 100,
  /** Largest monthly soft cap that can be entered, in estimated tokens. */
  tokenCap: 2_000_000_000,
  providers: 10,
} as const;

export interface ProviderDTO {
  id: string;
  name: string;
  kind: ProviderKind;
  protocol: Protocol | null;
  baseUrl: string | null;
  model: string | null;
  trust: Trust;
  hasKey: boolean;
  /** Last four characters of the saved key, so the person can tell which key it is. Never the key. */
  keyLast4: string | null;
  workspaceId: string | null;
  monthlyTokenCap: number | null;
  isDefault: boolean;
  enabled: boolean;
  /** Configured well enough to run tasks (or, for the hand-off, to receive them). */
  ready: boolean;
  /** Why it is not ready, in words. */
  notReadyReason: string | null;
  lastTest: { at: string; ok: boolean; message: string } | null;
  /** Estimated tokens used this calendar month (UTC) by tasks run on this provider. */
  usedThisMonth: number;
  createdAt: string;
}

/* ---- AI tasks ---- */

export const TASK_KINDS = ['improve_section', 'suggest_titles', 'check_accuracy', 'tighten_intro', 'outline', 'custom', 'adapt_for_platform', 'review_notes'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = ['pending', 'running', 'needs_review', 'accepted', 'rejected', 'failed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  improve_section: 'Improve this section',
  suggest_titles: 'Suggest titles',
  check_accuracy: 'Check technical accuracy',
  tighten_intro: 'Tighten',
  outline: 'Outline',
  custom: 'Ask',
  adapt_for_platform: 'Adapt for this destination',
  review_notes: 'Review this article',
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Waiting',
  running: 'Working',
  needs_review: 'Ready to review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  failed: 'Failed',
};

export interface TaskUsageDTO {
  tokensIn: number | null;
  tokensOut: number | null;
  /** True when a count is our estimate (characters divided by four) and not the provider's own number. */
  estimated: boolean;
  /** Answered from an earlier identical request: nothing was sent and nothing was spent. */
  fromCache: boolean;
  provider: string | null;
  model: string | null;
  /** Always null: the app does not know prices, so it never invents a cost. */
  costUsd: null;
}

export interface TaskNoteDTO {
  id: string;
  title: string;
  viaApproval: boolean;
}

/** An AI task as the browser sees it. Lists carry a shortened excerpt (`excerptTruncated`); a single task carries all of it. */
export interface TaskDTO {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  articleId: string;
  articleRevision: number;
  /** Set for a task made for one destination in the composer. */
  draftId: string | null;
  platform: string | null;
  selection: { start: number; end: number } | null;
  excerpt: string;
  excerptTruncated: boolean;
  instruction: string;
  provider: { id: string | null; name: string | null; kind: ProviderKind | null };
  model: string | null;
  result: TaskResult | null;
  error: string | null;
  /** Set when a result is waiting but the article text it was made for has changed. */
  stale: string | null;
  /** A hand-off task nobody has picked up yet: it waits for the person's own Claude Code. */
  waiting: boolean;
  usage: TaskUsageDTO;
  notes: TaskNoteDTO[];
  withheldCount: number;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** Sent over the event stream whenever a task changes, right after the change is committed. */
export interface TaskEvent {
  type: 'task';
  task: TaskDTO;
}

/** A provider that is ready to take tasks, as the studio lists it. */
export interface ReadyProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  isDefault: boolean;
  /** True when the app runs its tasks itself; false for the hand-off, which waits for Claude Code. */
  executes: boolean;
}

/** What the server says a task would send, so private notes can be approved by reading the text. */
export interface ContextPreviewDTO {
  providerId: string;
  providerName: string;
  providerKind: ProviderKind;
  trust: 'local' | 'external';
  leavesMachine: boolean;
  prompt: string;
  promptSha256: string;
  estimatedTokens: number;
  included: { id: string; title: string; viaApproval: boolean }[];
  withheld: { id: string; title: string }[];
}

export const TASK_LIMITS = {
  /** Longest selection a task accepts. */
  excerpt: 20_000,
  /** How much of an article a task without a selection reads. */
  wholeArticle: 12_000,
  instruction: 2_000,
} as const;

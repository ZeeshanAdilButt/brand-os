import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AI_LIMITS, KIND_INFO, PROTOCOLS, PROVIDER_KINDS, type Protocol, type ProviderDTO, type ProviderKind } from '../../lib/ai';
import { AdapterError } from '../ai/adapters/types';
import { encryptKey, masterKey, SecretUnavailableError } from '../ai/crypto';
import { redactSecrets } from '../ai/redact';
import { adapterFor, executesTasks, notReadyReason, plainKey, type AiEnv } from '../ai/runtime';
import { checkTarget, deriveTrust } from '../ai/target';
import type { PublicProvider } from '../data/ai-providers';
import { monthStart } from '../data/ai-tasks';
import { NotFoundError } from '../data/scope';
import { ActionError, parseId, parseInput, type OwnerContext } from './owner';

const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  trimmed(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));
const tokenCap = z
  .number({ error: 'Use a whole number of tokens.' })
  .int('Use a whole number of tokens.')
  .min(1, 'The cap must be at least 1 token.')
  .max(AI_LIMITS.tokenCap)
  .nullable()
  .optional();

export const providerCreateSchema = z
  .object({
    kind: z.enum(PROVIDER_KINDS),
    protocol: z.enum(PROTOCOLS).nullable().optional(),
    name: trimmed(AI_LIMITS.name).min(1, 'Give the provider a name.'),
    baseUrl: optionalText(AI_LIMITS.baseUrl),
    model: optionalText(AI_LIMITS.model),
    apiKey: trimmed(AI_LIMITS.apiKey).optional(),
    workspaceId: optionalText(AI_LIMITS.workspaceId),
    monthlyTokenCap: tokenCap,
  })
  .superRefine((value, ctx) => {
    const need = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: [field], message });
    if (value.kind === 'local') {
      if (!value.baseUrl) need('baseUrl', 'Enter the server address, for example http://localhost:11434/v1.');
      if (!value.model) need('model', 'Enter the model name.');
    }
    if (value.kind === 'api_key') {
      if (!value.protocol) need('protocol', 'Choose Anthropic or an OpenAI-compatible service.');
      if (!value.model) need('model', 'Enter the model name.');
      if (!value.apiKey) need('apiKey', 'Paste the API key.');
      if (value.protocol === 'openai_compatible' && !value.baseUrl) need('baseUrl', 'Enter the service address.');
    }
  });

/** For a patch: absent stays absent (keep the saved value); an empty string clears it. */
const patchText = (max: number) =>
  trimmed(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const providerPatchSchema = z.object({
  name: trimmed(AI_LIMITS.name).min(1, 'Give the provider a name.').optional(),
  baseUrl: patchText(AI_LIMITS.baseUrl),
  model: patchText(AI_LIMITS.model),
  /** A new key replaces the saved one. Leave it out to keep the saved key. */
  apiKey: trimmed(AI_LIMITS.apiKey).optional(),
  clearKey: z.boolean().optional(),
  workspaceId: patchText(AI_LIMITS.workspaceId),
  monthlyTokenCap: tokenCap,
  enabled: z.boolean().optional(),
});

export function toProviderDTO(row: PublicProvider, usedThisMonth = 0): ProviderDTO {
  const reason = notReadyReason({ ...row, encryptedKey: row.keyLast4 ? 'saved' : null });
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    model: row.model,
    trust: row.trust,
    hasKey: Boolean(row.keyLast4),
    keyLast4: row.keyLast4,
    workspaceId: row.workspaceId,
    monthlyTokenCap: row.monthlyTokenCap,
    isDefault: row.isDefault,
    enabled: row.enabled,
    ready: reason === null,
    notReadyReason: reason,
    lastTest: row.lastTestAt ? { at: row.lastTestAt.toISOString(), ok: Boolean(row.lastTestOk), message: row.lastTestMessage ?? '' } : null,
    usedThisMonth,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Providers with this calendar month's estimated token use, which the soft cap is measured against. */
export async function listProviders(owner: OwnerContext, now: Date = new Date()): Promise<ProviderDTO[]> {
  const [rows, usage] = await Promise.all([owner.data.providers.list(), owner.data.tasks.usageSince(monthStart(now))]);
  return rows.map((row) => toProviderDTO(row, usage.get(row.id) ?? 0));
}

/** True when at least one enabled provider is ready. When false the app is in no-AI mode: AI actions are disabled with an explanation. */
export async function aiAvailability(owner: OwnerContext): Promise<{ available: boolean; providers: { id: string; name: string; kind: ProviderKind; isDefault: boolean; executes: boolean }[] }> {
  const rows = await owner.data.providers.list();
  const ready = rows.filter((row) => notReadyReason({ ...row, encryptedKey: row.keyLast4 ? 'saved' : null }) === null);
  return {
    available: ready.length > 0,
    providers: ready.map((row) => ({ id: row.id, name: row.name, kind: row.kind, isDefault: row.isDefault, executes: executesTasks(row.kind) })),
  };
}

function checkAddress(env: AiEnv, kind: ProviderKind, protocol: Protocol | null, baseUrl: string): string {
  const result = checkTarget({ mode: env.config.mode, kind, protocol, baseUrl });
  if (!result.ok || !result.baseUrl) throw new ActionError('invalid', result.message ?? 'That address cannot be used.', { baseUrl: result.message ?? 'That address cannot be used.' });
  return result.baseUrl;
}

function sealKey(env: AiEnv, key: string, ownerId: string, providerId: string): string {
  try {
    return encryptKey(key, masterKey(env.config), ownerId, providerId);
  } catch (err) {
    if (err instanceof SecretUnavailableError) throw new ActionError('unavailable', err.message, { apiKey: err.message });
    throw err;
  }
}

export async function createProvider(owner: OwnerContext, env: AiEnv, input: unknown): Promise<ProviderDTO> {
  const values = parseInput(providerCreateSchema, input);
  if (owner.actor !== 'owner') throw new ActionError('forbidden', 'Providers can only be set up by signing in.');
  if (!KIND_INFO[values.kind].available) throw new ActionError('invalid', `${KIND_INFO[values.kind].label} is not available yet.`, { kind: 'This provider type is not built yet.' });
  if ((await owner.data.providers.count()) >= AI_LIMITS.providers) throw new ActionError('limit', `You can keep up to ${AI_LIMITS.providers} providers. Remove one first.`);

  const protocol: Protocol | null = values.kind === 'local' ? 'openai_compatible' : values.kind === 'api_key' ? (values.protocol ?? null) : null;
  let baseUrl: string | null = null;
  if (values.kind === 'local' || (values.kind === 'api_key' && protocol === 'openai_compatible')) {
    baseUrl = checkAddress(env, values.kind, protocol, values.baseUrl ?? '');
  }

  const id = randomUUID();
  const encryptedKey = values.apiKey ? sealKey(env, values.apiKey, owner.ownerId, id) : null;
  const row = await owner.data.providers.create({
    id,
    name: values.name,
    kind: values.kind,
    protocol,
    baseUrl,
    model: values.kind === 'claude_code_handoff' ? null : values.model,
    trust: deriveTrust(values.kind, baseUrl),
    encryptedKey,
    keyLast4: values.apiKey ? values.apiKey.slice(-4) : null,
    workspaceId: values.kind === 'api_key' && protocol === 'anthropic' ? values.workspaceId : null,
    monthlyTokenCap: values.kind === 'claude_code_handoff' ? null : (values.monthlyTokenCap ?? null),
  });
  await owner.data.audit.record({
    actor: owner.actor,
    action: 'ai_provider.created',
    entityType: 'ai_provider',
    entityId: row.id,
    metadata: { kind: row.kind, trust: row.trust },
  });
  return toProviderDTO(row);
}

export async function updateProvider(owner: OwnerContext, env: AiEnv, id: unknown, input: unknown): Promise<ProviderDTO> {
  const providerId = parseId(id, 'Provider');
  const values = parseInput(providerPatchSchema, input);
  if (owner.actor !== 'owner') throw new ActionError('forbidden', 'Providers can only be changed by signing in.');
  const current = await owner.data.providers.get(providerId);
  if (!current) throw new ActionError('not_found', 'Provider not found');

  const patch: Parameters<OwnerContext['data']['providers']['update']>[1] = {};
  if (values.name !== undefined) patch.name = values.name;
  if (values.model !== undefined && current.kind !== 'claude_code_handoff') patch.model = values.model;
  if (values.monthlyTokenCap !== undefined && current.kind !== 'claude_code_handoff') patch.monthlyTokenCap = values.monthlyTokenCap;
  if (values.enabled !== undefined) patch.enabled = values.enabled;
  if (values.workspaceId !== undefined && current.protocol === 'anthropic') patch.workspaceId = values.workspaceId;
  if (values.baseUrl !== undefined && current.protocol === 'openai_compatible') {
    if (!values.baseUrl) throw new ActionError('invalid', 'Enter the server address.', { baseUrl: 'Enter the server address.' });
    patch.baseUrl = checkAddress(env, current.kind, current.protocol, values.baseUrl);
    patch.trust = deriveTrust(current.kind, patch.baseUrl);
  }
  if (values.clearKey) {
    patch.encryptedKey = null;
    patch.keyLast4 = null;
  }
  if (values.apiKey) {
    patch.encryptedKey = sealKey(env, values.apiKey, owner.ownerId, current.id);
    patch.keyLast4 = values.apiKey.slice(-4);
  }
  try {
    const row = await owner.data.providers.update(providerId, patch);
    await owner.data.audit.record({
      actor: owner.actor,
      action: 'ai_provider.updated',
      entityType: 'ai_provider',
      entityId: row.id,
      metadata: { changedKey: Boolean(values.apiKey || values.clearKey), enabled: row.enabled },
    });
    return toProviderDTO(row, (await owner.data.tasks.usageSince(monthStart(new Date()))).get(row.id) ?? 0);
  } catch (err) {
    if (err instanceof NotFoundError) throw new ActionError('not_found', 'Provider not found');
    throw err;
  }
}

export async function setDefaultProvider(owner: OwnerContext, id: unknown): Promise<ProviderDTO> {
  const providerId = parseId(id, 'Provider');
  try {
    const row = await owner.data.providers.setDefault(providerId);
    await owner.data.audit.record({ actor: owner.actor, action: 'ai_provider.default_set', entityType: 'ai_provider', entityId: row.id });
    return toProviderDTO(row);
  } catch (err) {
    if (err instanceof NotFoundError) throw new ActionError('not_found', 'Provider not found');
    throw err;
  }
}

export async function deleteProvider(owner: OwnerContext, id: unknown): Promise<void> {
  const providerId = parseId(id, 'Provider');
  if (owner.actor !== 'owner') throw new ActionError('forbidden', 'Providers can only be removed by signing in.');
  if (!(await owner.data.providers.remove(providerId))) throw new ActionError('not_found', 'Provider not found');
  await owner.data.audit.record({ actor: owner.actor, action: 'ai_provider.deleted', entityType: 'ai_provider', entityId: providerId });
}

export interface TestOutcome {
  ok: boolean;
  message: string;
  latencyMs: number | null;
  /** The first words the model said, so the person can see it answered. */
  sample: string | null;
}

const TEST_SYSTEM = 'You are a connection test. Answer with one short word.';
const TEST_USER = 'Reply with the single word: ready';

/** Send one tiny, harmless prompt and report what happened. Nothing from the person's articles is sent. */
export async function testProvider(owner: OwnerContext, env: AiEnv, id: unknown): Promise<TestOutcome> {
  const providerId = parseId(id, 'Provider');
  const row = await owner.data.providers.getWithKey(providerId);
  if (!row) throw new ActionError('not_found', 'Provider not found');
  if (!executesTasks(row.kind)) {
    throw new ActionError('invalid', row.kind === 'claude_code_handoff' ? 'Nothing to test: tasks wait for your Claude Code.' : 'This provider type is not built yet.');
  }
  const started = Date.now();
  let outcome: TestOutcome;
  try {
    const adapter = adapterFor(env, row);
    const result = await adapter.complete({ system: TEST_SYSTEM, user: TEST_USER, maxOutputTokens: 32, timeoutMs: 20_000 });
    outcome = { ok: true, message: 'The provider answered.', latencyMs: Date.now() - started, sample: result.text.trim().slice(0, 80) };
  } catch (err) {
    let key: string | undefined;
    try {
      key = plainKey(env, row);
    } catch {
      key = undefined;
    }
    const message = err instanceof AdapterError ? err.message : 'The test failed.';
    outcome = { ok: false, message: redactSecrets(message, [key]), latencyMs: null, sample: null };
  }
  await owner.data.providers.recordTest(row.id, outcome.ok, outcome.ok ? 'The provider answered.' : outcome.message);
  await owner.data.audit.record({
    actor: owner.actor,
    action: 'ai_provider.tested',
    entityType: 'ai_provider',
    entityId: row.id,
    metadata: { ok: outcome.ok },
  });
  return outcome;
}

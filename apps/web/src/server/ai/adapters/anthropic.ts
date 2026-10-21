import { ANTHROPIC_BASE_URL } from '../../../lib/ai';
import {
  AdapterError,
  guardedFetch,
  httpFailure,
  readBody,
  type AdapterConfig,
  type CompletionResult,
  type ModelAdapter,
} from './types';

/** Required on every request; the docs list 2023-06-01 as the current value. */
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Anthropic Messages API: POST {base}/v1/messages with {model, max_tokens, system, messages:[{role:'user', content}]},
 * headers x-api-key (documented as the legacy form that still works; Authorization: Bearer is the newer one),
 * anthropic-version, and optionally anthropic-workspace-id. The answer is {content:[{type:'text', text}, ...],
 * stop_reason, usage:{input_tokens, output_tokens}}; errors are {type:'error', error:{type, message}} with 400, 401,
 * 403, 404, 413, 429 (with retry-after), 500, 504 and 529. Thinking blocks may appear before the text; only text
 * blocks are used. No sampling parameters are sent, since some current models refuse them. Sources: INTEGRATIONS.md.
 */
export function anthropicAdapter(config: AdapterConfig): ModelAdapter {
  const fetchFn = config.fetchFn ?? fetch;
  const secrets = [config.apiKey];
  const endpoint = `${(config.baseUrl || ANTHROPIC_BASE_URL).replace(/\/+$/, '')}/v1/messages`;

  return {
    protocol: 'anthropic',
    async complete(request): Promise<CompletionResult> {
      if (!config.apiKey) throw new AdapterError('misconfigured', 'No Anthropic API key is saved for this provider.');
      const response = await guardedFetch(
        fetchFn,
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            ...(config.workspaceId ? { 'anthropic-workspace-id': config.workspaceId } : {}),
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: [{ role: 'user', content: request.user }],
          }),
        },
        request,
        secrets,
      );
      const body = await readBody(response);
      if (!response.ok) throw httpFailure(response.status, body, response.headers.get('retry-after'), secrets);
      return parse(body);
    },
  };
}

function parse(body: unknown): CompletionResult {
  if (!body || typeof body !== 'object') throw new AdapterError('malformed', 'Anthropic answered with something that is not JSON.');
  const record = body as Record<string, unknown>;
  if (record.type === 'error') throw new AdapterError('client', 'Anthropic reported an error instead of an answer.');
  const blocks = Array.isArray(record.content) ? record.content : [];
  const text = blocks
    .map((block) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .join('');
  if (record.stop_reason === 'refusal') throw new AdapterError('malformed', 'The model declined to answer.');
  if (!text.trim()) throw new AdapterError('malformed', 'The model returned no text.');
  const usage = record.usage as Record<string, unknown> | undefined;
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
  return {
    text,
    usage: { inputTokens: count(usage?.input_tokens), outputTokens: count(usage?.output_tokens) },
    model: typeof record.model === 'string' ? record.model : null,
    truncated: record.stop_reason === 'max_tokens',
  };
}

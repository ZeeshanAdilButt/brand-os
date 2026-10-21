import {
  AdapterError,
  guardedFetch,
  httpFailure,
  readBody,
  type AdapterConfig,
  type CompletionRequest,
  type CompletionResult,
  type ModelAdapter,
} from './types';

/**
 * Chat completions in the OpenAI format: POST {base}/chat/completions with
 * {model, messages, max_tokens, temperature, stream:false}, answered with choices[0].message.content and
 * usage {prompt_tokens, completion_tokens}. Ollama serves this at http://localhost:11434/v1 (it ignores the
 * key; a placeholder is sent only when none is set), and LM Studio, vLLM, llama.cpp and hosted gateways
 * serve it too. Sources and what is unverified: INTEGRATIONS.md.
 *
 * Newer OpenAI models take `max_completion_tokens` and refuse `max_tokens`; many other servers only know
 * `max_tokens`. The first request uses `max_tokens`; if the server says that name is wrong, one retry uses
 * the other.
 */
export function openAiCompatible(config: AdapterConfig): ModelAdapter {
  const fetchFn = config.fetchFn ?? fetch;
  const secrets = [config.apiKey];
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  async function call(request: CompletionRequest, tokenField: 'max_tokens' | 'max_completion_tokens'): Promise<Response> {
    return guardedFetch(
      fetchFn,
      endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Ollama and some servers require a non-empty key header even though they ignore it.
          authorization: `Bearer ${config.apiKey || 'not-needed'}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          [tokenField]: request.maxOutputTokens,
          temperature: 0.2,
          stream: false,
        }),
      },
      request,
      secrets,
    );
  }

  return {
    protocol: 'openai_compatible',
    async complete(request): Promise<CompletionResult> {
      let response = await call(request, 'max_tokens');
      if (response.status === 400) {
        const body = await readBody(response);
        const message = JSON.stringify(body ?? '');
        if (/max_completion_tokens/.test(message) && /max_tokens/.test(message)) {
          response = await call(request, 'max_completion_tokens');
        } else {
          throw httpFailure(400, body, null, secrets);
        }
      }
      const body = await readBody(response);
      if (!response.ok) throw httpFailure(response.status, body, response.headers.get('retry-after'), secrets);
      return parse(body);
    },
  };
}

function parse(body: unknown): CompletionResult {
  if (!body || typeof body !== 'object') throw new AdapterError('malformed', 'The provider answered with something that is not JSON.');
  const record = body as Record<string, unknown>;
  if (record.error) throw new AdapterError('client', 'The provider reported an error instead of an answer.');
  const choice = Array.isArray(record.choices) ? (record.choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  let text = '';
  const content = message?.content;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('');
  }
  if (!text.trim()) throw new AdapterError('malformed', 'The model returned no text.');
  const usage = record.usage as Record<string, unknown> | undefined;
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
  return {
    text,
    usage: { inputTokens: count(usage?.prompt_tokens), outputTokens: count(usage?.completion_tokens) },
    model: typeof record.model === 'string' ? record.model : null,
    truncated: choice?.finish_reason === 'length',
  };
}

import type { TaskKind } from '../../lib/ai';
import { ResultRejected, validateResult, type TaskResult } from '../../lib/ai-ops';

/** Strip a code fence and pull out the first balanced JSON object, so a chatty model still parses. */
export function extractJson(text: string): unknown {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced?.[1]) body = fenced[1];
  const start = body.indexOf('{');
  if (start === -1) throw new ResultRejected('The model did not return a JSON object.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(body.slice(start, i + 1));
      } catch {
        throw new ResultRejected('The model returned JSON that could not be read.');
      }
    }
  }
  throw new ResultRejected('The model’s answer was cut off before the JSON ended.');
}

/** Parse and validate a model's text for a task kind. Throws ResultRejected with a readable reason. */
export function parseModelResult(kind: TaskKind, text: string): TaskResult {
  return validateResult(kind, extractJson(text));
}

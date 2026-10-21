import type { Operation, TaskResult } from '../../lib/ai-ops';

/**
 * Turning an accepted result into an article change. Pure functions over text, so the rules for "is this
 * result still true of the article?" are tested without a database. Nothing here runs unless a person
 * accepted the result, and every operation re-checks the live text first.
 */

/** The result no longer fits the article: the text it was made for has changed. */
export class StaleResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleResultError';
  }
}

export interface TaskTarget {
  /** Where the task's text started in the article when the task was made, or null for a whole-article task. */
  selStart: number | null;
  /** The text the task covered, as it was then. */
  excerpt: string;
}

/**
 * Where `needle` sits in `body`: at `hint` if it is still exactly there, otherwise at its only occurrence.
 * Null when it is gone, or when it appears several times and the position cannot be told (an ambiguous
 * match is treated as stale rather than guessed).
 */
export function locate(body: string, needle: string, hint: number | null): number | null {
  if (needle === '') return null;
  if (hint !== null && hint >= 0 && body.startsWith(needle, hint)) return hint;
  const first = body.indexOf(needle);
  if (first === -1) return null;
  return body.indexOf(needle, first + 1) === -1 ? first : null;
}

/** Position of the task's own text in the live article. */
function locateExcerpt(body: string, target: TaskTarget): number {
  const at = locate(body, target.excerpt, target.selStart ?? 0);
  if (at === null) throw new StaleResultError('The text this was made for has changed or moved since. Run the task again on the current text.');
  return at;
}

export interface Plan {
  body: string;
  /** A title the person chose from a list, if the result was a title list. */
  title: string | null;
  /** How many replacements and insertions were applied. */
  edits: number;
}

function outlineMarkdown(headings: { level: number; text: string }[]): string {
  return headings.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n\n');
}

/**
 * Work out the article body that accepting this result would give, or throw StaleResultError. A
 * replace_range may only touch text inside the task's own excerpt, and its `original` must still be found,
 * exactly once, in the live article.
 */
export function planChanges(body: string, target: TaskTarget, result: TaskResult, choice: { titleIndex?: number | undefined } = {}): Plan {
  const edits: { start: number; end: number; text: string }[] = [];
  let title: string | null = null;

  for (const op of result.operations) {
    if (op.type === 'replace_range') {
      if (!target.excerpt.includes(op.original)) {
        throw new StaleResultError('This change is not inside the text it was made for, so it cannot be applied.');
      }
      const excerptAt = locateExcerpt(body, target);
      const inside = target.excerpt.indexOf(op.original);
      const at = body.startsWith(op.original, excerptAt + inside) ? excerptAt + inside : locate(body, op.original, null);
      if (at === null) throw new StaleResultError('The original text no longer matches the article. It was changed after this result was made.');
      edits.push({ start: at, end: at + op.original.length, text: op.proposed });
    } else if (op.type === 'insert_after') {
      const at = target.selStart === null ? body.length : locateExcerpt(body, target) + target.excerpt.length;
      edits.push({ start: at, end: at, text: `${at === body.length && body.length > 0 && !body.endsWith('\n') ? '\n\n' : ''}${op.text}` });
    } else if (op.type === 'outline') {
      const at = target.selStart === null ? body.length : locateExcerpt(body, target) + target.excerpt.length;
      edits.push({ start: at, end: at, text: `\n\n${outlineMarkdown(op.headings)}\n` });
    } else if (op.type === 'suggest_titles') {
      const index = choice.titleIndex;
      if (index === undefined || !Number.isInteger(index) || index < 0 || index >= op.titles.length) {
        throw new StaleResultError('Choose one of the suggested titles to use.');
      }
      title = op.titles[index] ?? null;
    }
    // review_notes change nothing: accepting them only marks them as read.
  }

  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < edits.length; i++) {
    const prev = edits[i - 1]!;
    const next = edits[i]!;
    if (next.start < prev.end) throw new StaleResultError('Two changes in this result overlap, so it cannot be applied.');
  }
  let out = body;
  for (const edit of [...edits].reverse()) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return { body: out, title, edits: edits.length };
}

/** Why a waiting result no longer fits the article, in words, or null when it still does. */
export function staleReason(body: string, target: TaskTarget, result: TaskResult): string | null {
  const needsText = result.operations.some((op) => op.type === 'replace_range' || op.type === 'insert_after' || (op.type === 'outline' && target.selStart !== null));
  if (!needsText) return null;
  try {
    planChanges(body, target, result, { titleIndex: 0 });
    return null;
  } catch (err) {
    if (err instanceof StaleResultError) return err.message;
    throw err;
  }
}

/** True when every replace_range in the result quotes text that really is part of the task's excerpt. */
export function originalsInsideExcerpt(excerpt: string, result: TaskResult): boolean {
  return result.operations.every((op: Operation) => op.type !== 'replace_range' || excerpt.includes(op.original));
}

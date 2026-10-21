import { z } from 'zod';
import type { TaskKind } from './ai';

/**
 * The only things a model (or Claude Code) may return for a task: a short list of structured
 * operations. Nothing here can publish, delete, run a command or call a tool; it is text that a
 * person looks at and accepts or rejects. Used by the server to validate every result and by the
 * UI to render it, so the rules live in one place.
 */

export const OP_LIMITS = {
  text: 20_000,
  rationale: 1_000,
  titles: 10,
  title: 200,
  notes: 30,
  quote: 1_000,
  note: 2_000,
  headings: 40,
  heading: 200,
  operations: 5,
  description: 500,
  tags: 20,
  tag: 40,
  body: 100_000,
} as const;

/** Remove fenced blocks and inline code, so generics such as Map<String, Integer> in code are not mistaken for markup. */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/~~~[\s\S]*?(~~~|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/** True when prose (outside code) contains an HTML tag, comment or script-style handler. */
export function containsHtml(text: string): boolean {
  const prose = withoutCode(text);
  return /<\/?[a-zA-Z][^>]*>|<!--|<!\[CDATA\[|<\?[a-z]/.test(prose);
}

const noHtml = (value: string) => !containsHtml(value);
const NO_HTML = 'HTML is not allowed in AI results. Use Markdown.';

const text = (max: number, min = 0) => z.string().min(min).max(max).refine(noHtml, NO_HTML);

export const replaceRangeOp = z.object({
  type: z.literal('replace_range'),
  /** The exact text being replaced. Checked against the live article before anything is applied. */
  original: z.string().min(1).max(OP_LIMITS.text),
  proposed: text(OP_LIMITS.text),
  rationale: text(OP_LIMITS.rationale).default(''),
});

export const suggestTitlesOp = z.object({
  type: z.literal('suggest_titles'),
  titles: z.array(text(OP_LIMITS.title, 1)).min(1).max(OP_LIMITS.titles),
});

export const reviewNotesOp = z.object({
  type: z.literal('review_notes'),
  notes: z
    .array(
      z.object({
        severity: z.enum(['info', 'warning', 'error']),
        quote: z.string().max(OP_LIMITS.quote).default(''),
        note: text(OP_LIMITS.note, 1),
      }),
    )
    .min(1)
    .max(OP_LIMITS.notes),
});

export const insertAfterOp = z.object({
  type: z.literal('insert_after'),
  /** Inserted right after the selected text. */
  text: text(OP_LIMITS.text, 1),
});

export const outlineOp = z.object({
  type: z.literal('outline'),
  headings: z
    .array(z.object({ level: z.number().int().min(1).max(4), text: text(OP_LIMITS.heading, 1) }))
    .min(1)
    .max(OP_LIMITS.headings),
});

/**
 * A proposal for one destination's draft: any of a new title, description and tags, and either a rewritten
 * opening or a whole new body. It is shown as a diff against the draft and applied only when accepted.
 */
export const adaptProposalOp = z
  .object({
    type: z.literal('adapt_proposal'),
    title: text(OP_LIMITS.title, 1).optional(),
    description: text(OP_LIMITS.description).optional(),
    tags: z.array(z.string().trim().min(1).max(OP_LIMITS.tag).refine(noHtml, NO_HTML)).max(OP_LIMITS.tags).optional(),
    /** The opening of the destination's body as it is now, and what should replace it. */
    intro: z.object({ original: z.string().min(1).max(OP_LIMITS.text), proposed: text(OP_LIMITS.text, 1) }).optional(),
    body: text(OP_LIMITS.body, 1).optional(),
    rationale: text(OP_LIMITS.rationale).default(''),
  })
  .refine((v) => v.title !== undefined || v.description !== undefined || v.tags !== undefined || v.intro !== undefined || v.body !== undefined, {
    message: 'Propose at least one change: a title, description, tags, intro or body.',
  })
  .refine((v) => v.intro === undefined || v.body === undefined, { message: 'Return either an intro or a whole body, not both.' });

export const operationSchema = z.discriminatedUnion('type', [replaceRangeOp, suggestTitlesOp, reviewNotesOp, insertAfterOp, outlineOp, adaptProposalOp]);
export type Operation = z.infer<typeof operationSchema>;
export type OperationType = Operation['type'];

export const OPERATION_TYPES = ['replace_range', 'suggest_titles', 'review_notes', 'insert_after', 'outline', 'adapt_proposal'] as const satisfies readonly OperationType[];

/** A result is a short list of operations. */
export const resultSchema = z.object({
  operations: z.array(operationSchema).min(1, 'Return at least one operation.').max(OP_LIMITS.operations),
});
export type TaskResult = z.infer<typeof resultSchema>;

/** Which operations each kind of task may return. A result outside this set is refused, whatever the text said. */
export const ALLOWED_OPERATIONS: Record<TaskKind, readonly OperationType[]> = {
  improve_section: ['replace_range', 'review_notes'],
  tighten_intro: ['replace_range'],
  suggest_titles: ['suggest_titles'],
  check_accuracy: ['review_notes'],
  outline: ['outline'],
  custom: ['replace_range', 'insert_after', 'review_notes', 'suggest_titles', 'outline'],
  adapt_for_platform: ['adapt_proposal'],
  review_notes: ['review_notes'],
};

export class ResultRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultRejected';
  }
}

/**
 * Validate a result for a task kind. Throws ResultRejected with a message a person can read. Used for
 * a model's answer and for a result submitted over MCP: one set of rules for both.
 */
export function validateResult(kind: TaskKind, raw: unknown): TaskResult {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (${issue.path.join('.')})` : '';
    throw new ResultRejected(`The result is not in the expected format${where}: ${issue?.message ?? 'invalid'}.`);
  }
  const allowed = ALLOWED_OPERATIONS[kind];
  for (const op of parsed.data.operations) {
    if (!allowed.includes(op.type)) {
      throw new ResultRejected(`A "${kind}" task cannot return a "${op.type}" operation. Allowed: ${allowed.join(', ')}.`);
    }
  }
  return parsed.data;
}

/** The operation shapes in words, for the model's instructions and for Claude Code's task view. */
export function operationHelp(kind: TaskKind): string {
  const shapes: Record<OperationType, string> = {
    replace_range: '{"type":"replace_range","original":"<the exact text being replaced, copied character for character>","proposed":"<the replacement, Markdown>","rationale":"<one short sentence>"}',
    suggest_titles: '{"type":"suggest_titles","titles":["<title>", "..."]}',
    review_notes: '{"type":"review_notes","notes":[{"severity":"info|warning|error","quote":"<short quote from the text>","note":"<what to check or fix>"}]}',
    insert_after: '{"type":"insert_after","text":"<Markdown to insert right after the selected text>"}',
    outline: '{"type":"outline","headings":[{"level":2,"text":"<heading>"}]}',
    adapt_proposal:
      '{"type":"adapt_proposal","title":"<optional new title>","description":"<optional new description>","tags":["<optional tag>"],"intro":{"original":"<the destination body opening, copied exactly>","proposed":"<the rewritten opening>"},"rationale":"<one short sentence>"} (send "body":"<whole new body>" instead of "intro" to replace the whole body; every field except type is optional but at least one change is required)',
  };
  return ALLOWED_OPERATIONS[kind].map((type) => `- ${shapes[type]}`).join('\n');
}

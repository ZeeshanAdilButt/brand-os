import { z } from 'zod';

/**
 * The operations a result may contain. This mirrors apps/web/src/lib/ai-ops.ts so a malformed result is
 * refused before it leaves the machine; the app re-checks every result with its own copy, which is the one
 * that counts. A test (test/drift.test.ts) feeds both the same cases and fails if they ever disagree.
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
} as const;

function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/~~~[\s\S]*?(~~~|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

export function containsHtml(text: string): boolean {
  return /<\/?[a-zA-Z][^>]*>|<!--|<!\[CDATA\[|<\?[a-z]/.test(withoutCode(text));
}

const NO_HTML = 'HTML is not allowed in AI results. Use Markdown.';
const text = (max: number, min = 0) => z.string().min(min).max(max).refine((v) => !containsHtml(v), NO_HTML);

export const replaceRangeOp = z.object({
  type: z.literal('replace_range'),
  original: z.string().min(1).max(OP_LIMITS.text).describe('The exact text being replaced, copied character for character from the task excerpt.'),
  proposed: text(OP_LIMITS.text).describe('The replacement, in Markdown. No HTML.'),
  rationale: text(OP_LIMITS.rationale).default('').describe('One short sentence on why.'),
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
  text: text(OP_LIMITS.text, 1).describe('Markdown inserted right after the selected text.'),
});

export const outlineOp = z.object({
  type: z.literal('outline'),
  headings: z.array(z.object({ level: z.number().int().min(1).max(4), text: text(OP_LIMITS.heading, 1) })).min(1).max(OP_LIMITS.headings),
});

export const operationSchema = z.discriminatedUnion('type', [replaceRangeOp, suggestTitlesOp, reviewNotesOp, insertAfterOp, outlineOp]);
export type Operation = z.infer<typeof operationSchema>;

export const operationsSchema = z.array(operationSchema).min(1, 'Return at least one operation.').max(OP_LIMITS.operations);

import { describe, expect, it } from 'vitest';
import { resultSchema as appSchema, OP_LIMITS as appLimits } from '../../../apps/web/src/lib/ai-ops';
import { OP_LIMITS, operationsSchema } from '../src/operations.js';

/**
 * The app is the authority on what a result may contain. The MCP server keeps its own copy of the rules so a
 * bad result is refused before it is sent. This test fails if the two ever disagree on a case.
 */
const big = 'x'.repeat(OP_LIMITS.text + 1);
const replace = { type: 'replace_range', original: 'The cache is fast.', proposed: 'The cache answers in under a millisecond.', rationale: 'Specific.' };

const CASES: unknown[][] = [
  [replace],
  [{ ...replace, rationale: undefined }],
  [{ type: 'suggest_titles', titles: ['A', 'B'] }],
  [{ type: 'review_notes', notes: [{ severity: 'warning', quote: 'fast', note: 'Compared to what?' }] }],
  [{ type: 'insert_after', text: 'More.' }],
  [{ type: 'outline', headings: [{ level: 2, text: 'Setup' }] }],
  [replace, { type: 'review_notes', notes: [{ severity: 'info', quote: '', note: 'ok' }] }],
  [{ ...replace, proposed: 'Use `Map<String, Integer>` here.\n\n```java\nList<String> a = new ArrayList<>();\n```' }],
  [{ ...replace, original: 'Line with <br> inside' }],
  // Rejected by both:
  [],
  [{ type: 'delete_article' }],
  [{ type: 'publish', platform: 'devto' }],
  [{ ...replace, proposed: '<script>alert(1)</script>' }],
  [{ ...replace, proposed: 'Click <a href="https://example.test">here</a>' }],
  [{ ...replace, proposed: 'text <!-- hidden --> text' }],
  [{ ...replace, original: '' }],
  [{ ...replace, proposed: big }],
  [{ ...replace, original: big }],
  [{ ...replace, rationale: 'r'.repeat(OP_LIMITS.rationale + 1) }],
  [{ type: 'suggest_titles', titles: [] }],
  [{ type: 'suggest_titles', titles: Array.from({ length: OP_LIMITS.titles + 1 }, (_, i) => `T${i}`) }],
  [{ type: 'suggest_titles', titles: ['<b>x</b>'] }],
  [{ type: 'review_notes', notes: [{ severity: 'critical', quote: '', note: 'x' }] }],
  [{ type: 'review_notes', notes: [] }],
  [{ type: 'insert_after', text: '' }],
  [{ type: 'outline', headings: [{ level: 9, text: 'x' }] }],
  [{ type: 'outline', headings: [{ level: 2, text: '<h1>x</h1>' }] }],
  Array.from({ length: OP_LIMITS.operations + 1 }, () => replace),
];

describe('result rules: the MCP copy and the app agree', () => {
  it('share the same limits', () => {
    expect(OP_LIMITS).toEqual(appLimits);
  });

  it.each(CASES.map((c, i) => [i, JSON.stringify(c).slice(0, 70), c] as const))('case %i: %s', (_i, _label, operations) => {
    const mine = operationsSchema.safeParse(operations).success;
    const theirs = appSchema.safeParse({ operations }).success;
    expect(mine).toBe(theirs);
  });

  it('accepts the same parsed shape', () => {
    const mine = operationsSchema.parse([replace]);
    const theirs = appSchema.parse({ operations: [replace] }).operations;
    expect(mine).toEqual(theirs);
  });
});

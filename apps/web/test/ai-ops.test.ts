import { describe, expect, it } from 'vitest';
import { TASK_KINDS } from '../src/lib/ai';
import { ALLOWED_OPERATIONS, containsHtml, OP_LIMITS, ResultRejected, validateResult } from '../src/lib/ai-ops';
import { extractJson, parseModelResult } from '../src/server/ai/output';

const replace = { type: 'replace_range', original: 'The cache is fast.', proposed: 'The cache answers in under a millisecond.', rationale: 'More specific.' };

describe('result validation', () => {
  it('accepts each operation shape for the task kinds that allow it', () => {
    expect(validateResult('improve_section', { operations: [replace] }).operations).toHaveLength(1);
    expect(validateResult('suggest_titles', { operations: [{ type: 'suggest_titles', titles: ['A', 'B'] }] }).operations[0]?.type).toBe('suggest_titles');
    expect(
      validateResult('check_accuracy', { operations: [{ type: 'review_notes', notes: [{ severity: 'warning', quote: 'fast', note: 'Fast compared to what?' }] }] }).operations[0]?.type,
    ).toBe('review_notes');
    expect(validateResult('outline', { operations: [{ type: 'outline', headings: [{ level: 2, text: 'Setup' }] }] }).operations[0]?.type).toBe('outline');
    expect(validateResult('custom', { operations: [{ type: 'insert_after', text: 'More.' }] }).operations[0]?.type).toBe('insert_after');
  });

  it('rejects operations the task kind may not return, whatever else is valid', () => {
    expect(() => validateResult('suggest_titles', { operations: [replace] })).toThrow(/cannot return a "replace_range"/);
    expect(() => validateResult('check_accuracy', { operations: [replace] })).toThrow(ResultRejected);
    expect(() => validateResult('tighten_intro', { operations: [{ type: 'insert_after', text: 'x' }] })).toThrow(ResultRejected);
    for (const kind of TASK_KINDS) expect(ALLOWED_OPERATIONS[kind].length).toBeGreaterThan(0);
  });

  it('rejects unknown or action-like operations and malformed shapes', () => {
    for (const bad of [
      { operations: [{ type: 'delete_article', id: '1' }] },
      { operations: [{ type: 'run_command', command: 'curl example.test' }] },
      { operations: [{ type: 'publish', platform: 'devto' }] },
      { operations: [] },
      { operations: 'nope' },
      {},
      null,
      [],
      { operations: [{ type: 'replace_range', original: '', proposed: 'x' }] },
      { operations: [{ type: 'replace_range', original: 'x' }] },
      { operations: [{ type: 'suggest_titles', titles: [] }] },
      { operations: [{ type: 'outline', headings: [{ level: 9, text: 'x' }] }] },
      { operations: [{ type: 'review_notes', notes: [{ severity: 'critical', quote: '', note: 'x' }] }] },
    ]) {
      expect(() => validateResult('custom', bad), JSON.stringify(bad)).toThrow(ResultRejected);
    }
  });

  it('enforces size limits', () => {
    const big = 'x'.repeat(OP_LIMITS.text + 1);
    expect(() => validateResult('improve_section', { operations: [{ ...replace, proposed: big }] })).toThrow(ResultRejected);
    expect(() => validateResult('improve_section', { operations: [{ ...replace, original: big }] })).toThrow(ResultRejected);
    expect(() => validateResult('improve_section', { operations: [{ ...replace, rationale: 'r'.repeat(OP_LIMITS.rationale + 1) }] })).toThrow(ResultRejected);
    expect(() => validateResult('suggest_titles', { operations: [{ type: 'suggest_titles', titles: Array.from({ length: OP_LIMITS.titles + 1 }, (_, i) => `T${i}`) }] })).toThrow(ResultRejected);
    expect(() => validateResult('suggest_titles', { operations: [{ type: 'suggest_titles', titles: ['t'.repeat(OP_LIMITS.title + 1)] }] })).toThrow(ResultRejected);
    expect(() => validateResult('custom', { operations: Array.from({ length: OP_LIMITS.operations + 1 }, () => replace) })).toThrow(ResultRejected);
  });

  it('rejects HTML in proposed text, titles, notes and outlines, but allows generics in code', () => {
    for (const html of ['<script>alert(1)</script>', 'Click <a href="https://example.test">here</a>', '<img src=x onerror=alert(1)>', 'text <!-- hidden --> text', '</div>']) {
      expect(containsHtml(html), html).toBe(true);
      expect(() => validateResult('improve_section', { operations: [{ ...replace, proposed: html }] })).toThrow(/HTML is not allowed/);
    }
    expect(() => validateResult('suggest_titles', { operations: [{ type: 'suggest_titles', titles: ['<b>Bold</b> title'] }] })).toThrow(ResultRejected);
    expect(() => validateResult('check_accuracy', { operations: [{ type: 'review_notes', notes: [{ severity: 'info', quote: '', note: '<iframe src=x></iframe>' }] }] })).toThrow(ResultRejected);
    expect(() => validateResult('outline', { operations: [{ type: 'outline', headings: [{ level: 2, text: '<h1>x</h1>' }] }] })).toThrow(ResultRejected);

    const code = 'Use `Map<String, Integer>` here.\n\n```java\nList<String> names = new ArrayList<>();\n```\n\nAlso 2 < 3 and a <- b.';
    expect(containsHtml(code)).toBe(false);
    expect(validateResult('improve_section', { operations: [{ ...replace, proposed: code }] }).operations).toHaveLength(1);
  });

  it('does not check the original text for HTML, because it is compared with the article', () => {
    const op = { ...replace, original: 'Line with <br> inside' };
    expect(validateResult('improve_section', { operations: [op] }).operations).toHaveLength(1);
  });
});

describe('reading a model answer', () => {
  it('finds the JSON in a fenced or chatty answer', () => {
    const json = JSON.stringify({ operations: [replace] });
    expect(parseModelResult('improve_section', json).operations).toHaveLength(1);
    expect(parseModelResult('improve_section', '```json\n' + json + '\n```').operations).toHaveLength(1);
    expect(parseModelResult('improve_section', 'Sure! Here you go:\n' + json + '\nHope that helps.').operations).toHaveLength(1);
    expect(extractJson('{"a":"} not the end","b":{"c":1}} trailing')).toEqual({ a: '} not the end', b: { c: 1 } });
  });

  it('refuses answers that are not usable', () => {
    expect(() => parseModelResult('improve_section', 'I cannot help with that.')).toThrow(/did not return a JSON object/);
    expect(() => parseModelResult('improve_section', '{"operations":[{"type":"replace_range","original":"a"')).toThrow(/cut off/);
    expect(() => parseModelResult('improve_section', '{"operations": [oops]}')).toThrow(/could not be read/);
    expect(() => parseModelResult('improve_section', '{"operations": [{"type":"delete_article"}]}')).toThrow(ResultRejected);
  });
});

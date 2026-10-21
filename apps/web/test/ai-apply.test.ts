import { describe, expect, it } from 'vitest';
import type { TaskResult } from '../src/lib/ai-ops';
import { locate, originalsInsideExcerpt, planChanges, staleReason, StaleResultError } from '../src/server/ai/apply';

const BODY = '# T\n\nFirst paragraph.\n\nSecond paragraph here.\n\nThird.\n';
const EXCERPT = 'Second paragraph here.';
const START = BODY.indexOf(EXCERPT);
const target = { selStart: START, excerpt: EXCERPT };
const replace = (original: string, proposed: string): TaskResult => ({ operations: [{ type: 'replace_range', original, proposed, rationale: '' }] });

describe('locating text', () => {
  it('finds it at the hint, or at its only occurrence, and gives up when ambiguous or gone', () => {
    expect(locate(BODY, EXCERPT, START)).toBe(START);
    expect(locate(BODY, EXCERPT, 0)).toBe(START);
    expect(locate(BODY, 'paragraph', null)).toBeNull();
    expect(locate(BODY, 'missing', START)).toBeNull();
    expect(locate(BODY, '', 0)).toBeNull();
  });
});

describe('planning an accepted result', () => {
  it('replaces the original text and nothing else', () => {
    const plan = planChanges(BODY, target, replace(EXCERPT, 'Second one, shorter.'));
    expect(plan.body).toBe(BODY.replace(EXCERPT, 'Second one, shorter.'));
    expect(plan.edits).toBe(1);
  });

  it('still applies after text before it moved', () => {
    const moved = `Added line.\n\n${BODY}`;
    expect(planChanges(moved, target, replace(EXCERPT, 'X')).body).toBe(moved.replace(EXCERPT, 'X'));
  });

  it('refuses when the original changed or went missing', () => {
    const edited = BODY.replace('here', 'there');
    expect(() => planChanges(edited, target, replace(EXCERPT, 'X'))).toThrow(StaleResultError);
    expect(staleReason(edited, target, replace(EXCERPT, 'X'))).toMatch(/changed or moved|no longer matches/);
    expect(staleReason(BODY, target, replace(EXCERPT, 'X'))).toBeNull();
  });

  it('refuses when the text now appears twice, rather than guessing which one', () => {
    const twice = `${BODY}\n${EXCERPT}\n`;
    // Still exactly where the task found it: fine, even though a copy now exists elsewhere.
    expect(() => planChanges(twice, target, replace(EXCERPT, 'X'))).not.toThrow();
    // Moved, and now ambiguous: stale.
    expect(() => planChanges(`Added.\n\n${twice}`, target, replace(EXCERPT, 'X'))).toThrow(StaleResultError);
  });

  it('refuses a change that reaches outside the text the task covered', () => {
    expect(() => planChanges(BODY, target, replace('First paragraph.', 'X'))).toThrow(/not inside the text/);
    expect(originalsInsideExcerpt(EXCERPT, replace('First paragraph.', 'X'))).toBe(false);
    expect(originalsInsideExcerpt(EXCERPT, replace('paragraph here', 'X'))).toBe(true);
  });

  it('applies several changes and refuses overlapping ones', () => {
    const two: TaskResult = {
      operations: [
        { type: 'replace_range', original: 'Second', proposed: '2nd', rationale: '' },
        { type: 'replace_range', original: 'here.', proposed: 'now.', rationale: '' },
      ],
    };
    expect(planChanges(BODY, target, two).body).toBe(BODY.replace('Second paragraph here.', '2nd paragraph now.'));
    const overlap: TaskResult = {
      operations: [
        { type: 'replace_range', original: 'Second paragraph', proposed: 'A', rationale: '' },
        { type: 'replace_range', original: 'paragraph here', proposed: 'B', rationale: '' },
      ],
    };
    expect(() => planChanges(BODY, target, overlap)).toThrow(/overlap/);
  });

  it('inserts after the selection, or at the end for a whole-article task, and appends an outline', () => {
    const after: TaskResult = { operations: [{ type: 'insert_after', text: 'Inserted.' }] };
    expect(planChanges(BODY, target, after).body).toBe(BODY.replace(EXCERPT, `${EXCERPT}Inserted.`));
    const whole = planChanges('Short body', { selStart: null, excerpt: 'Short body' }, after);
    expect(whole.body).toBe('Short body\n\nInserted.');
    const outline: TaskResult = { operations: [{ type: 'outline', headings: [{ level: 2, text: 'One' }, { level: 3, text: 'Two' }] }] };
    expect(planChanges('Body', { selStart: null, excerpt: 'Body' }, outline).body).toBe('Body\n\n## One\n\n### Two\n');
  });

  it('applies a chosen title only, and review notes change nothing', () => {
    const titles: TaskResult = { operations: [{ type: 'suggest_titles', titles: ['A', 'B'] }] };
    expect(planChanges(BODY, { selStart: null, excerpt: BODY }, titles, { titleIndex: 1 })).toMatchObject({ title: 'B', body: BODY, edits: 0 });
    expect(() => planChanges(BODY, { selStart: null, excerpt: BODY }, titles)).toThrow(/Choose one/);
    expect(() => planChanges(BODY, { selStart: null, excerpt: BODY }, titles, { titleIndex: 5 })).toThrow(/Choose one/);
    const notes: TaskResult = { operations: [{ type: 'review_notes', notes: [{ severity: 'info', quote: '', note: 'x' }] }] };
    expect(planChanges(BODY, target, notes)).toMatchObject({ body: BODY, edits: 0, title: null });
  });
});

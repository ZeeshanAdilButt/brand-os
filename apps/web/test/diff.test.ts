import { describe, expect, it } from 'vitest';
import { collapseUnchanged, diffLines, diffStats } from '../src/lib/diff';

const rebuild = (lines: ReturnType<typeof diffLines>, side: 'old' | 'new') =>
  lines
    .filter((l) => (side === 'old' ? l.kind !== 'add' : l.kind !== 'del'))
    .map((l) => l.text)
    .join('\n');

describe('line diff', () => {
  it('reports no change for equal text', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nb\nc\n');
    expect(lines.every((l) => l.kind === 'equal')).toBe(true);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 0 });
  });

  it('finds an inserted, a removed and a changed line with line numbers', () => {
    const lines = diffLines('one\ntwo\nthree\nfour\n', 'one\ntwo and a half\nthree\nfour\nfive\n');
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      'equal:one',
      'del:two',
      'add:two and a half',
      'equal:three',
      'equal:four',
      'add:five',
    ]);
    expect(lines[1]).toMatchObject({ oldNo: 2, newNo: null });
    expect(lines[2]).toMatchObject({ oldNo: null, newNo: 2 });
    expect(lines[5]).toMatchObject({ oldNo: null, newNo: 5 });
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
  });

  it('handles empty sides', () => {
    expect(diffLines('', 'a\nb').map((l) => l.kind)).toEqual(['add', 'add']);
    expect(diffLines('a\nb', '').map((l) => l.kind)).toEqual(['del', 'del']);
    expect(diffLines('', '')).toEqual([]);
  });

  it('treats CRLF like LF', () => {
    expect(diffStats(diffLines('a\r\nb\r\n', 'a\nb\n'))).toEqual({ added: 0, removed: 0 });
  });

  it('reconstructs both texts exactly for many random edits', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const words = ['alpha', 'beta', 'gamma', 'delta', '', 'code', '```', '- item', '# head'];
    for (let round = 0; round < 200; round++) {
      const old = Array.from({ length: Math.floor(rand() * 30) }, () => words[Math.floor(rand() * words.length)]!);
      const next = old.slice();
      for (let edit = 0; edit < Math.floor(rand() * 8); edit++) {
        const at = Math.floor(rand() * (next.length + 1));
        if (rand() < 0.5) next.splice(at, 0, words[Math.floor(rand() * words.length)]!);
        else next.splice(at, 1);
      }
      const a = old.join('\n');
      const b = next.join('\n');
      const lines = diffLines(a, b);
      expect(rebuild(lines, 'old')).toBe(a.replace(/\n$/, ''));
      expect(rebuild(lines, 'new')).toBe(b.replace(/\n$/, ''));
    }
  });

  it('falls back to a coarse diff for wildly different long texts, still correct', () => {
    const a = Array.from({ length: 2500 }, (_, i) => `old ${i}`).join('\n');
    const b = Array.from({ length: 2500 }, (_, i) => `new ${i}`).join('\n');
    const lines = diffLines(a, b);
    expect(diffStats(lines)).toEqual({ added: 2500, removed: 2500 });
    expect(rebuild(lines, 'old')).toBe(a);
    expect(rebuild(lines, 'new')).toBe(b);
  });

  it('collapses long unchanged runs but keeps context around changes', () => {
    const base = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const changed = base.slice();
    changed[20] = 'changed';
    const rows = collapseUnchanged(diffLines(base.join('\n'), changed.join('\n')), 2);
    expect(rows.filter((r) => r.kind === 'gap')).toEqual([
      { kind: 'gap', hidden: 18 },
      { kind: 'gap', hidden: 17 },
    ]);
    expect(rows.filter((r) => r.kind === 'del' || r.kind === 'add')).toHaveLength(2);
  });
});

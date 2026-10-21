import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NotesParseError, parsePublishingNotes } from '../src/notes.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))).toString('utf8');
const sample = fixture('sample-notes.md');
const crlfBom = fixture('crlf-bom-notes.md');

describe('parsePublishingNotes', () => {
  const pkg = parsePublishingNotes(sample);

  it('reads the bulleted alternate titles (no colon on the label)', () => {
    expect(pkg.alternateTitles).toHaveLength(3);
    expect(pkg.alternateTitles[0]).toBe('Queues Are Where Latency Lives');
  });

  it('reads the verify-before-publishing checklist', () => {
    expect(pkg.verifyBeforePublishing).toEqual([
      "Confirm the Little's Law statement against the cited paper.",
      'Re-check the p99 figure against the current dashboard.',
    ]);
  });

  it('reads the fact labels', () => {
    expect(pkg.factLabels).toHaveLength(3);
    expect(pkg.factLabels[1]).toMatch(/^Measured on the fleet/);
  });

  it('reads single-line labels', () => {
    expect(pkg.primaryTitle).toBe('How Queues Hide Latency, Starting From One Counter');
    expect(pkg.metaTitle).toBe('How Queues Hide Latency: A Counter-First View');
    expect(pkg.ogText).toBe('Service time is 4 ms. Queue time is the rest. Measure the queue.');
    expect(pkg.excerpt).toMatch(/^Latency lives in queues\./);
    expect(pkg.metaDescription).toMatch(/^Latency lives in queues, not in service time/);
    expect(pkg.searchIntent).toMatch(/^An engineer with a slow endpoint/);
    expect(pkg.internalLinks).toBe('The capacity planning playbook.');
    expect(pkg.furtherReading).toBe('utilisation, then saturation, then tail latency.');
  });

  it("splits key entities on ', ' and trims the trailing period", () => {
    expect(pkg.keyEntities).toEqual(['latency', 'queue', "Little's Law", 'utilisation', 'p99', 'saturation']);
  });

  it('ignores unknown bold labels', () => {
    expect(JSON.stringify(pkg)).not.toContain('Reviewer mood');
    expect(JSON.stringify(pkg)).not.toContain('not part of the set');
  });

  it('parses a CRLF + BOM copy identically', () => {
    expect(crlfBom.startsWith('\uFEFF')).toBe(true);
    expect(crlfBom).toContain('\r\n');
    expect(parsePublishingNotes(crlfBom)).toEqual(pkg);
  });

  it('gives undefined for missing optional labels and empty arrays for missing lists', () => {
    const minimal = parsePublishingNotes(
      '**Meta description:** A description.\n\n**Excerpt (index/home):** An excerpt.\n',
    );
    expect(minimal.metaDescription).toBe('A description.');
    expect(minimal.excerpt).toBe('An excerpt.');
    expect(minimal.alternateTitles).toEqual([]);
    expect(minimal.keyEntities).toEqual([]);
    expect(minimal.factLabels).toEqual([]);
    expect(minimal.verifyBeforePublishing).toEqual([]);
    expect(minimal.metaTitle).toBeUndefined();
    expect(minimal.searchIntent).toBeUndefined();
    expect(minimal.primaryTitle).toBeUndefined();
    expect(minimal.ogText).toBeUndefined();
    expect('metaTitle' in minimal).toBe(false);
    expect('primaryTitle' in minimal).toBe(false);
    expect('ogText' in minimal).toBe(false);
  });

  describe('scanner edge cases', () => {
    const doc = (...lines: string[]): string => `${lines.join('\n')}\n`;
    const required = ['**Meta description:** D.', '', '**Excerpt (index/home):** E.'];

    it('joins a wrapped indented bullet onto the bullet above it', () => {
      const p = parsePublishingNotes(
        doc(...required, '', '## Verify before publishing', '', '- First check that', '  wraps onto a second line.', '- Second check.'),
      );
      expect(p.verifyBeforePublishing).toEqual(['First check that wraps onto a second line.', 'Second check.']);
    });

    it('does not join an unindented line onto a bullet', () => {
      const p = parsePublishingNotes(doc(...required, '## Fact labels used', '- One.', 'stray paragraph', '- Two.'));
      expect(p.factLabels).toEqual(['One.', 'Two.']);
    });

    it('joins a wrapped label value that follows the label with no blank line', () => {
      const p = parsePublishingNotes(doc('**Meta description:** A description', 'that wraps.', '', '**Excerpt (index/home):** E.'));
      expect(p.metaDescription).toBe('A description that wraps.');
    });

    it('does not extend a label value across a blank line', () => {
      const p = parsePublishingNotes(doc('**Meta description:** D.', '', 'loose paragraph', '', '**Excerpt (index/home):** E.'));
      expect(p.metaDescription).toBe('D.');
    });

    it('keeps the first value of a duplicated label', () => {
      const p = parsePublishingNotes(
        doc('**Meta description:** First.', '**Meta description:** Second.', '**Excerpt (index/home):** E.'),
      );
      expect(p.metaDescription).toBe('First.');
    });

    it('attaches a stray bullet to the preceding label and ignores it unless that label is the alternate titles', () => {
      const p = parsePublishingNotes(doc('**Primary title:** Title', '- stray bullet', ...required));
      expect(p.primaryTitle).toBe('Title');
      expect(p.alternateTitles).toEqual([]);
      expect(JSON.stringify(p)).not.toContain('stray bullet');
    });

    it('ignores bullets before any label or heading', () => {
      const p = parsePublishingNotes(doc('- orphan', ...required));
      expect(p.alternateTitles).toEqual([]);
      expect(p.factLabels).toEqual([]);
    });

    it('stops collecting alternate titles at the next heading', () => {
      const p = parsePublishingNotes(doc('**Alternate titles**', '- A', '## Other', '- not a title', ...required));
      expect(p.alternateTitles).toEqual(['A']);
    });
  });

  it('throws NotesParseError when the meta description is missing', () => {
    try {
      parsePublishingNotes('**Excerpt (index/home):** An excerpt.\n');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NotesParseError);
      expect((error as NotesParseError).field).toBe('Meta description');
    }
  });

  it('throws NotesParseError when the excerpt is missing or empty', () => {
    expect(() => parsePublishingNotes('**Meta description:** D.\n')).toThrow(NotesParseError);
    expect(() => parsePublishingNotes('**Meta description:** D.\n**Excerpt (index/home):**\n')).toThrow(
      NotesParseError,
    );
  });
});

import type { PublishingPackage } from './model.js';
import { normalizeText } from './normalize.js';

export class NotesParseError extends Error {
  readonly field: string;
  readonly reason: string;

  constructor(field: string, reason: string) {
    super(`Invalid publishing notes, label "${field}": ${reason}`);
    this.name = 'NotesParseError';
    this.field = field;
    this.reason = reason;
  }
}

interface LabelEntry {
  value: string;
  bullets: string[];
}

// `**Primary title:** text` and the colon-less `**Alternate titles**`.
const LABEL = /^\*\*(.+?):?\*\*:?\s*(.*)$/;
const BULLET = /^-\s+(.*)$/;

const key = (label: string): string => label.trim().toLowerCase();

/**
 * Parse a publishing-notes file (spec 2.3) with a line scanner: bold labels, `## ` sections and
 * `- ` bullets. Unknown labels are ignored. Throws `NotesParseError` when the meta description or
 * the excerpt is missing.
 */
export function parsePublishingNotes(raw: string): PublishingPackage {
  const labels = new Map<string, LabelEntry>();
  const factLabels: string[] = [];
  const verifyBeforePublishing: string[] = [];

  let section: 'none' | 'facts' | 'verify' | 'other' = 'none';
  let current: LabelEntry | null = null;
  // What a continuation line (indented, wrapped) extends: a label value or the last bullet.
  let tail: { list: string[]; index: number } | { entry: LabelEntry } | null = null;

  for (const line of normalizeText(raw).split('\n')) {
    const trimmed = line.trim();

    if (trimmed === '') {
      tail = null;
      continue;
    }

    if (trimmed.startsWith('#')) {
      current = null;
      tail = null;
      const heading = key(trimmed.replace(/^#+\s*/, ''));
      if (trimmed.startsWith('## ')) {
        section = heading === 'fact labels used' ? 'facts' : heading === 'verify before publishing' ? 'verify' : 'other';
      } else {
        section = 'none';
      }
      continue;
    }

    const label = LABEL.exec(trimmed);
    if (label) {
      const name = key(label[1] ?? '');
      current = labels.get(name) ?? { value: (label[2] ?? '').trim(), bullets: [] };
      if (!labels.has(name)) labels.set(name, current);
      tail = { entry: current };
      continue;
    }

    const bullet = BULLET.exec(trimmed);
    if (bullet) {
      const text = (bullet[1] ?? '').trim();
      const list = section === 'facts' ? factLabels : section === 'verify' ? verifyBeforePublishing : current?.bullets;
      if (list) {
        list.push(text);
        tail = { list, index: list.length - 1 };
      } else {
        tail = null;
      }
      continue;
    }

    // Wrapped text: only indented lines extend a bullet; a plain line directly after a label extends its value.
    if (tail && 'list' in tail && /^\s/.test(line)) {
      tail.list[tail.index] = `${tail.list[tail.index] ?? ''} ${trimmed}`;
    } else if (tail && 'entry' in tail) {
      tail.entry.value = `${tail.entry.value} ${trimmed}`.trim();
    }
  }

  const value = (name: string): string | undefined => {
    const v = labels.get(key(name))?.value;
    return v === undefined || v === '' ? undefined : v;
  };
  const required = (name: string): string => {
    const v = value(name);
    if (v === undefined) throw new NotesParseError(name, 'missing or empty');
    return v;
  };

  const entities = value('Key entities / terms');

  const pkg: PublishingPackage = {
    alternateTitles: labels.get(key('Alternate titles'))?.bullets ?? [],
    metaDescription: required('Meta description'),
    excerpt: required('Excerpt (index/home)'),
    keyEntities: entities === undefined ? [] : entities.replace(/\.$/, '').split(', ').map((e) => e.trim()).filter(Boolean),
    factLabels,
    verifyBeforePublishing,
  };
  const optional: [keyof PublishingPackage, string][] = [
    ['primaryTitle', 'Primary title'],
    ['metaTitle', 'Meta title'],
    ['ogText', 'OG / social card text'],
    ['socialVisualConcept', 'Social visual concept'],
    ['searchIntent', 'Search intent'],
    ['internalLinks', 'Suggested internal links'],
    ['furtherReading', 'Further-reading path'],
  ];
  for (const [field, name] of optional) {
    const v = value(name);
    if (v !== undefined) (pkg as unknown as Record<string, string>)[field] = v;
  }
  return pkg;
}

import matter from 'gray-matter';
import { z } from 'zod';
import { CATEGORIES } from './model.js';
import { normalizeText } from './normalize.js';
import type { Frontmatter } from './model.js';

export class PostParseError extends Error {
  readonly field: string;
  readonly reason: string;

  constructor(field: string, reason: string) {
    super(`Invalid post frontmatter, field "${field}": ${reason}`);
    this.name = 'PostParseError';
    this.field = field;
    this.reason = reason;
  }
}

// YAML turns an unquoted `date: 2026-07-19` into a Date at UTC midnight.
const isoDate = z.preprocess(
  (value) => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : value),
  z.iso.date(),
);

export const FrontmatterSchema = z.object({
  title: z.string().min(1),
  date: isoDate,
  category: z.enum(CATEGORIES),
  tags: z.array(z.string().min(1)),
  description: z.string(),
  published: z.boolean(),
  coverImage: z.string().min(1),
}) satisfies z.ZodType<Frontmatter>;

// gray-matter would otherwise evaluate `---js` frontmatter as code.
const refuseCode = (): never => {
  throw new Error('code frontmatter is not allowed');
};

/**
 * Parse a post file. A BOM and CRLF line endings are normalised first, so the
 * same post gives identical results on any checkout. Throws `PostParseError`.
 */
export function parsePost(raw: string): { frontmatter: Frontmatter; body: string } {
  const text = normalizeText(raw);

  let parsed: matter.GrayMatterFile<string>;
  try {
    // An options object also stops gray-matter from caching (and sharing) results.
    parsed = matter(text, { engines: { js: refuseCode, javascript: refuseCode } });
  } catch (error) {
    throw new PostParseError('frontmatter', error instanceof Error ? error.message : String(error));
  }

  if (Object.keys(parsed.data).length === 0) {
    throw new PostParseError('frontmatter', 'missing or empty frontmatter block');
  }

  const result = FrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new PostParseError(issue?.path.join('.') || 'frontmatter', issue?.message ?? 'invalid value');
  }
  return { frontmatter: result.data, body: parsed.content };
}

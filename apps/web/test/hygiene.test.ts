import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(webRoot, '../..');

const SKIP_DIRS = new Set(['node_modules', '.next', '.data', 'dist']);
// Generated and gitignored: `next dev` rewrites it with text we do not control.
const SKIP_FILES = new Set(['AGENTS.md']);
const TEXT_EXT = /\.(ts|tsx|css|json|sql|md|mjs|yml|yaml|example)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (TEXT_EXT.test(entry.name) || entry.name === '.env.example') out.push(full);
  }
  return out;
}

// Files this suite checks: the web app plus the repo-level docs and config this task owns.
const rootDocs = ['ARCHITECTURE.md', 'DECISIONS.md', 'INTEGRATIONS.md', 'CLAUDE.md', 'TODO.md', '.env.example', 'package.json']
  .map((f) => path.join(repoRoot, f))
  .filter((f) => fs.existsSync(f));
const files = [...walk(webRoot), ...rootDocs].filter((f) => path.basename(f) !== 'hygiene.test.ts');

const EM_DASH = String.fromCharCode(0x2014);
// Provider-shaped secrets, assembled from parts so this file never contains a literal match.
const SECRET_SHAPES: [string, RegExp][] = [
  ['OpenAI-style key', new RegExp(['s', 'k-[A-Za-z0-9_-]{20,}'].join(''))],
  ['GitHub token', new RegExp(['gh', 'p_[A-Za-z0-9]{30,}'].join(''))],
  ['AWS access key', new RegExp(['AK', 'IA[0-9A-Z]{16}'].join(''))],
  ['Google key', new RegExp(['AI', 'za[0-9A-Za-z_-]{30,}'].join(''))],
  ['JWT', new RegExp(['ey', 'J[A-Za-z0-9_-]{15,}\\.', 'ey', 'J'].join(''))],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

describe('repository hygiene for the web app and its docs', () => {
  it('scans a meaningful set of files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('contains no em dashes', () => {
    const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes(EM_DASH)).map((f) => path.relative(repoRoot, f));
    expect(hits).toEqual([]);
  });

  it.each(SECRET_SHAPES)('contains no %s', (_label, pattern) => {
    const hits = files.filter((f) => pattern.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(repoRoot, f));
    expect(hits).toEqual([]);
  });

  it('keeps the data directory out of git', () => {
    const ignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\.data\/$/m);
    expect(ignore).toMatch(/^\.env$/m);
  });
});

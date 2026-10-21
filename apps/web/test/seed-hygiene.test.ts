import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(webRoot, '../..');
const SEED_FILE = path.join(webRoot, 'seed', 'owner.private.json');

type Json = Record<string, unknown>;
const asArray = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string[] => (typeof v === 'string' && v.trim() ? [v] : []);
const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** Free-text claims and narrative: distinctive by construction, so they must appear nowhere in git. */
function narrativeValues(seed: Json): string[] {
  const profile = (seed.profile ?? {}) as Json;
  const preferences = (seed.preferences ?? {}) as Json;
  return [
    ...asArray(seed.items).flatMap((i) => [...str(i.title), ...str(i.body)]),
    ...str(profile.careerGoals),
    ...str(preferences.audience),
    ...str(preferences.writingStyle),
  ].map(normalize);
}

/** Who the owner is: name, headline, location and any personal address. */
function identityValues(seed: Json): string[] {
  const profile = (seed.profile ?? {}) as Json;
  return [
    ...str(profile.name),
    ...str(profile.headline),
    ...str(profile.location),
    ...asArray(seed.sources).flatMap((s) => str(s.uri)),
  ].map(normalize);
}

function trackedTextFiles(): { file: string; text: string }[] {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const out: { file: string; text: string }[] = [];
  for (const rel of listed.split('\0').filter(Boolean)) {
    const full = path.join(repoRoot, rel);
    if (!fs.existsSync(full)) continue; // removed in the working tree, not yet committed
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) continue;
    const buffer = fs.readFileSync(full);
    if (buffer.includes(0)) continue; // binary
    out.push({ file: rel, text: normalize(buffer.toString('utf8')) });
  }
  return out;
}

/** Report file path and value number only, so a failure never prints private content. */
function findHits(values: string[], files: { file: string; text: string }[]): string[] {
  const hits: string[] = [];
  for (const { file, text } of files) {
    values.forEach((value, index) => {
      if (text.includes(value)) hits.push(`${file} (seed value #${index})`);
    });
  }
  return hits;
}

/** Identity is checked over every tracked file: the repo must read like a generic product. */
const IDENTITY_SCOPE = (_file: string) => true;

describe('private owner seed never leaks into git', () => {
  const present = fs.existsSync(SEED_FILE);

  it('keeps the seed file ignored and untracked', () => {
    execFileSync('git', ['check-ignore', '-q', 'apps/web/seed/owner.private.json'], { cwd: repoRoot, stdio: 'pipe' });
    const tracked = execFileSync('git', ['ls-files', 'apps/web/seed'], { cwd: repoRoot }).toString('utf8').trim();
    expect(tracked).toBe('');
  });

  it.skipIf(!present)('no claim or narrative from the seed file appears in any tracked file', () => {
    const values = narrativeValues(JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) as Json);
    expect(values.length).toBeGreaterThan(10);
    const files = trackedTextFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(findHits(values, files)).toEqual([]);
  });

  it.skipIf(!present)('the owner identity from the seed file does not appear in the web app or its docs', () => {
    const values = identityValues(JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) as Json);
    expect(values.length).toBeGreaterThan(2);
    const files = trackedTextFiles().filter((f) => IDENTITY_SCOPE(f.file));
    expect(files.length).toBeGreaterThan(20);
    expect(findHits(values, files)).toEqual([]);
  });

  it.skipIf(present)('is skipped on a machine without the private seed file', () => {
    expect(present).toBe(false);
  });
});

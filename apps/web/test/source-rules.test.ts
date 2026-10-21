import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(import.meta.dirname, '..');
const srcRoot = path.join(webRoot, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(webRoot, file).split(path.sep).join('/');
const sources = walk(srcRoot).map((file) => ({ file: rel(file), text: fs.readFileSync(file, 'utf8') }));
const inside = (file: string, ...dirs: string[]) => dirs.some((d) => file.startsWith(d));

/** Tables whose rows belong to one owner. Only src/server/data may query them. */
const TENANT_TABLES = ['profiles', 'brandPreferences', 'knowledgeSources', 'knowledgeItems', 'auditEvents', 'articles', 'articleVersions', 'assets', 'studioSettings'];
const TENANT_TABLE_SQL =
  /\b(knowledge_items|knowledge_sources|brand_preferences|audit_events|profiles|article_versions|studio_settings)\b|\b(from|join|into|update)\s+"?(articles|assets)\b/;

/** Names imported from the schema module in a piece of source text. */
export function schemaImports(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]*db\/schema['"]/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe('data access boundary (source rules)', () => {
  it('scans the server and app code', () => {
    expect(sources.length).toBeGreaterThan(40);
    expect(sources.some((s) => s.file === 'src/server/data/tenant.ts')).toBe(true);
  });

  it('the rule itself detects a violation (it is not vacuous)', () => {
    expect(schemaImports("import { users, knowledgeItems } from '../db/schema';")).toEqual(['users', 'knowledgeItems']);
    expect(schemaImports("import { type KnowledgeItem } from '@/server/db/schema'")).toEqual(['KnowledgeItem']);
    expect(TENANT_TABLE_SQL.test('select * from knowledge_items')).toBe(true);
  });

  it('no code outside src/server/data and src/server/db imports a tenant table', () => {
    const offenders = sources
      .filter((s) => !inside(s.file, 'src/server/data/', 'src/server/db/'))
      .filter((s) => schemaImports(s.text).some((name) => TENANT_TABLES.includes(name)))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it('no raw SQL naming a tenant table outside src/server/data and src/server/db', () => {
    const offenders = sources
      .filter((s) => !inside(s.file, 'src/server/data/', 'src/server/db/'))
      .filter((s) => TENANT_TABLE_SQL.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it('only the data layer and the database module import the query builder', () => {
    const offenders = sources
      .filter((s) => !inside(s.file, 'src/server/data/', 'src/server/db/'))
      .filter((s) => /from\s+['"]drizzle-orm/.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it('pages, components and route files never import the data layer or the database directly', () => {
    const offenders = sources
      .filter((s) => inside(s.file, 'src/app/', 'src/components/'))
      .filter((s) => /from\s+['"](@\/server\/(data|db)|(\.\.\/)+server\/(data|db))/.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it('forOwner is called only where the owner id derives from a session (or the seed, which checks the designated owner)', () => {
    const allowed = new Set(['src/server/actions/owner.ts', 'src/server/data/seed.ts', 'src/server/data/tenant.ts']);
    const offenders = sources
      .filter((s) => !allowed.has(s.file))
      .filter((s) => /\bforOwner\s*\(/.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it('request handlers never read an owner id from the request', () => {
    const handlerFiles = sources.filter((s) => inside(s.file, 'src/server/http/', 'src/app/api/', 'src/server/actions/'));
    expect(handlerFiles.length).toBeGreaterThan(5);
    const offenders = handlerFiles
      .filter((s) => /(body|params|searchParams|query|input)\??\.(ownerId|owner_id|userId)\b|get\(['"](ownerId|owner_id|userId)['"]\)/.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it('the scripts that touch data go through the data layer too', () => {
    const scripts = ['scripts/seed-owner.ts', 'scripts/migrate.ts']
      .filter((f) => fs.existsSync(path.join(webRoot, f)))
      .map((f) => ({ file: f, text: fs.readFileSync(path.join(webRoot, f), 'utf8') }));
    for (const s of scripts) {
      expect(schemaImports(s.text).filter((n) => TENANT_TABLES.includes(n)), s.file).toEqual([]);
      expect(TENANT_TABLE_SQL.test(s.text), s.file).toBe(false);
    }
  });
});

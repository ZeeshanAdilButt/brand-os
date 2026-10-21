import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

interface RootPackage {
  pnpm?: { onlyBuiltDependencies?: string[]; ignoredBuiltDependencies?: string[] };
}

describe('build config', () => {
  // better-sqlite3 ships prebuilt binaries (prebuilds/<platform>.node) and has no install script, but
  // it still carries a binding.gyp. Allowing its build makes pnpm run an implicit node-gyp rebuild,
  // which fails on CI runners without a detectable Visual Studio. Its build must stay ignored.
  it('never lets pnpm rebuild better-sqlite3 from source', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as RootPackage;
    expect(pkg.pnpm?.onlyBuiltDependencies ?? []).not.toContain('better-sqlite3');
    expect(pkg.pnpm?.ignoredBuiltDependencies ?? []).toContain('better-sqlite3');
  });

  it('loads better-sqlite3 from its prebuilt binary in the daemon package', () => {
    const require = createRequire(join(repoRoot, 'packages', 'daemon', 'package.json'));
    const Database = require('better-sqlite3') as new (file: string) => {
      prepare(sql: string): { get(): unknown };
      close(): void;
    };
    const db = new Database(':memory:');
    expect(db.prepare('select 1 as one').get()).toEqual({ one: 1 });
    db.close();
  });
});

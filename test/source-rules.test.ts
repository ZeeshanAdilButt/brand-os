import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, matchesGlob, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export interface SourceHit {
  file: string;
  line: number;
}

// Never descend into dependencies or build output. Node passes a Dirent
// (or, in some versions, a path string) to the exclude callback.
const skipDir = (entry: string | { name: string }): boolean => {
  const name = (typeof entry === 'string' ? entry : entry.name).split(/[\\/]/).pop();
  return name === 'node_modules' || name === 'dist';
};

/**
 * Scan source files for lines matching `pattern`.
 * Globs are relative to `cwd` (the repo root by default). A glob starting with
 * `!` removes matching files from the result. Returned `file` paths are
 * relative to `cwd` and use forward slashes. `line` is 1-based.
 */
export function scanSources(globs: string[], pattern: RegExp, cwd: string = repoRoot): SourceHit[] {
  const hits: SourceHit[] = [];
  for (const file of collectFiles(globs, cwd)) {
    const lines = readFileSync(join(cwd, file), 'utf8').split(/\r?\n/);
    lines.forEach((text, index) => {
      if (pattern.test(text)) hits.push({ file: file, line: index + 1 });
    });
  }
  return hits;
}

/**
 * Like `scanSources`, but matches `pattern` against each whole file, so it can see statements
 * that span lines (a multi-line `import { ... } from`). `line` is the line where the match starts.
 */
export function scanSourcesWhole(globs: string[], pattern: RegExp, cwd: string = repoRoot): SourceHit[] {
  const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  const hits: SourceHit[] = [];
  for (const file of collectFiles(globs, cwd)) {
    const text = readFileSync(join(cwd, file), 'utf8');
    for (const match of text.matchAll(global)) {
      hits.push({ file, line: text.slice(0, match.index).split('\n').length });
    }
  }
  return hits;
}

function collectFiles(globs: string[], cwd: string): string[] {
  const include = globs.filter((g) => !g.startsWith('!'));
  const exclude = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  const files = new Set<string>();
  for (const glob of include) {
    for (const match of globSync(glob, { cwd, exclude: skipDir })) files.add(match.split(sep).join('/'));
  }
  return [...files].sort().filter((file) => !exclude.some((glob) => matchesGlob(file, glob)));
}

const SOURCE_GLOBS = ['packages/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];

// Rule: no-browser-automation.
// No import of playwright or puppeteer outside packages/daemon/src/assets/
// (phase 1: screenshots of our own site only).
const BROWSER_AUTOMATION_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](?:playwright|puppeteer)(?:-core|-extra)?(?:\/[^'"]*)?['"]/;
const BROWSER_AUTOMATION_ALLOWED = '!packages/daemon/src/assets/**';

// Rule: site-read-only.
// The personal site repo is read-only. Only packages/daemon/src/site/guarded-fs.ts may import
// node:fs write APIs; everything else goes through guardedFs, which refuses any path under the
// site. Flagged: a named import (or re-export) of a write API, a namespace or default import of
// node:fs (it carries the whole write surface), a require/dynamic import of node:fs, and member
// access like `fs.writeFile` / `fs.promises.rm`. Test files are not scanned.
const FS_MODULE = String.raw`['"](?:node:)?fs(?:/promises)?['"]`;
const FS_WRITE_API = String.raw`(?:writeFile|appendFile|mkdir|rm|rmdir|rename|copyFile|cp|truncate|unlink|createWriteStream)(?:Sync)?`;
const FS_WRITE_IMPORT = new RegExp(
  [
    String.raw`\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[^}]*\b${FS_WRITE_API}\b[^}]*\}\s*from\s*${FS_MODULE}`,
    String.raw`\bimport\s+(?:\*\s+as\s+[\w$]+|[\w$]+)(?:\s*,\s*\{[^}]*\})?\s+from\s*${FS_MODULE}`,
    String.raw`\b(?:require|import)\s*\(\s*${FS_MODULE}\s*\)`,
    String.raw`\b(?:fs|fsp|fsPromises|promises)\s*\.\s*(?:promises\s*\.\s*)?${FS_WRITE_API}\b`,
  ].join('|'),
  'g',
);
const SRC_ONLY_GLOBS = ['packages/*/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', '!**/*.test.*'];
const SITE_READ_ONLY_ALLOWED = '!packages/daemon/src/site/guarded-fs.ts';

// Rule: git-allowlist.
// Spawning git is allowed only in packages/daemon/src/site/git.ts, and there only as
// `execFile…('git', ['--no-optional-locks', …`. (Without the flag `git status` can rewrite
// .git/index, which is a write to the site repo.)
const GIT_SPAWN_ANY = new RegExp(
  String.raw`\b(?:execFile|execFileSync|execFileAsync|spawn|spawnSync)\s*\(\s*['"\x60]git(?:\.exe)?['"\x60]|\b(?:exec|execSync)\s*\(\s*['"\x60]git\b`,
  'g',
);
const GIT_SPAWN_NO_LOCKS_FIRST = new RegExp(
  String.raw`\b(?:execFile|execFileSync|execFileAsync)\s*\(\s*['"]git['"]\s*,\s*\[\s*['"]--no-optional-locks['"]`,
  'g',
);
const GIT_FILE = 'packages/daemon/src/site/git.ts';
const GIT_ALLOWED = `!${GIT_FILE}`;

// Rule: verified-mint-only-in-gate.
// A VerifiedApproval is the only thing a route accepts, so only the approval gate may mint one:
// `mintVerifiedApproval` may appear only in gate/verified.ts (its definition) and gate/approval-gate.ts.
const MINT_VERIFIED = /\bmintVerifiedApproval\b/;
const MINT_FILES = ['packages/daemon/src/gate/verified.ts', 'packages/daemon/src/gate/approval-gate.ts'];

// Rule: approved-only-from-gate.
// `approvals.setStatus(<id>, 'approved', ...)` may appear only in gate/approval-gate.ts, after the
// presence check. Any setStatus call whose status is not a plain string literal is flagged too, so a
// variable cannot smuggle 'approved' past the rule (db/repos.ts holds the definition and is exempt).
const SET_APPROVED = /\bsetStatus\s*\(\s*[^,()]+,\s*['"`]approved['"`]/g;
const SET_STATUS_NOT_LITERAL = /\bsetStatus\s*\(\s*[^,()]+,(?!\s*['"`][a-z_]+['"`]\s*[,)])/g;
const GATE_FILE = 'packages/daemon/src/gate/approval-gate.ts';
const REPOS_FILE = 'packages/daemon/src/db/repos.ts';

// Rule: devto-publish-only.
// A dev.to article goes public only through `DevtoRoute.publish` in routes/devto.ts, which spreads
// the live flag after the payload. The literal may appear nowhere else in source (comment-only lines
// are ignored). The enclosing method is found with a simple brace-depth scan.
const DEVTO_LIVE_FLAG = /\bpublished['"]?\s*:\s*true\b/;
const DEVTO_ROUTE_FILE = 'packages/daemon/src/routes/devto.ts';
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

// Rule: buffer-sharenow-only.
// A Buffer post goes out immediately only through `BufferRoute.publish` in routes/buffer.ts. The
// literal `shareNow` may appear nowhere else in source: not in the client, not in `stage`. Comment-only
// lines and members of a string-literal union type (`'shareNow' | 'addToQueue'`) are not code.
const BUFFER_SHARE_NOW = /\bshareNow\b/;
const BUFFER_ROUTE_FILE = 'packages/daemon/src/routes/buffer.ts';
const UNION_MEMBER_LINE = /['"][\w-]+['"]\s*\|\s*['"][\w-]+['"]/;

// Rule: buffer-queue-needs-draft.
// `addToQueue` puts a post in the live queue unless `saveToDraft: true` is set, so every object
// literal that contains it must also contain `saveToDraft: true` (the literal true, not a variable).
const BUFFER_ADD_TO_QUEUE = /\baddToQueue\b/;
const SAVE_TO_DRAFT_TRUE = /\bsaveToDraft\s*:\s*true\b/;

// Rule: no-buffer-mcp.
// Buffer is reached only through its GraphQL API behind the gate. The hosted Buffer MCP endpoint
// must not be configured or called from anywhere in packages/.
const BUFFER_MCP_HOST = /mcp\.buffer\.com/i;
const ALL_PACKAGE_FILES = ['packages/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,md,html,txt,sql,ps1,yml,yaml}'];

/**
 * The text of the innermost `{ ... }` around 0-based `offset` in `source`, or undefined when the
 * offset is not inside braces. Brace-depth scan; braces inside strings are not special-cased.
 */
export function enclosingObjectLiteral(source: string, offset: number): string | undefined {
  let depth = 0;
  let start = -1;
  for (let i = offset; i >= 0; i--) {
    const ch = source[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return undefined;
  depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Code hits: not comment-only lines and not members of a string-union type. */
function bufferCodeHits(globs: string[], pattern: RegExp, cwd: string = repoRoot): SourceHit[] {
  return codeHits(globs, pattern, cwd).filter(({ file, line }) => {
    const text = readFileSync(join(cwd, file), 'utf8').split(/\r?\n/)[line - 1] ?? '';
    return !UNION_MEMBER_LINE.test(text);
  });
}

/** 0-based offset of the first match of `pattern` on 1-based `line` of `source`. */
function offsetOnLine(source: string, line: number, pattern: RegExp): number {
  const lines = source.split('\n');
  let start = 0;
  for (let i = 0; i < line - 1; i++) start += (lines[i] as string).length + 1;
  return start + Math.max(0, (lines[line - 1] as string).search(pattern));
}

/**
 * Names the class member (`Class.member`) that contains 1-based `line`, or undefined when the line
 * is outside every class method. Brace-depth scan: a member starts at a line shaped like
 * `[modifiers] name(` at class-body depth and ends when depth returns to the class-body depth.
 */
export function enclosingClassMember(source: string, line: number): string | undefined {
  const MEMBER =
    /^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*(#?[A-Za-z_$][\w$]*)\s*[(<]/;
  let depth = 0;
  let className: string | undefined;
  let bodyDepth = -1;
  let member: string | undefined;
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] as string;
    if (className === undefined) {
      const cls = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(text);
      if (cls?.[1] !== undefined && depth === 0) {
        className = cls[1];
        bodyDepth = depth + 1;
      }
    } else if (member === undefined && depth === bodyDepth) {
      const m = MEMBER.exec(text);
      if (m?.[1] !== undefined) member = `${className}.${m[1]}`;
    }
    if (i + 1 === line) return member;
    for (const ch of text) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (member !== undefined && depth <= bodyDepth) member = undefined;
    if (className !== undefined && depth < bodyDepth) {
      className = undefined;
      member = undefined;
    }
  }
  return undefined;
}

/** Hits of `pattern` in code, skipping lines that are only a comment. */
function codeHits(globs: string[], pattern: RegExp, cwd: string = repoRoot): SourceHit[] {
  return scanSources(globs, pattern, cwd).filter(({ file, line }) => {
    const text = readFileSync(join(cwd, file), 'utf8').split(/\r?\n/)[line - 1] ?? '';
    return !COMMENT_LINE.test(text);
  });
}

describe('scanSources', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'cph scan '));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, name);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content);
    }
    return dir;
  }

  it('reports file and 1-based line, handles CRLF, and honours ! globs', () => {
    const cwd = fixture({
      'packages/a/src/x.ts': "import a from 'a';\r\nimport { chromium } from 'playwright';\r\n",
      'packages/daemon/src/assets/shot.ts': "import { chromium } from 'playwright';\n",
      'packages/a/node_modules/dep/index.js': "import 'playwright';\n",
      'packages/a/dist/x.js': "import 'playwright';\n",
      'packages/b/src/y.ts': "const p = await import('puppeteer');\nconst q = require('puppeteer-core');\n",
    });
    const all = scanSources(SOURCE_GLOBS, BROWSER_AUTOMATION_IMPORT, cwd);
    expect(all).toEqual([
      { file: 'packages/a/src/x.ts', line: 2 },
      { file: 'packages/b/src/y.ts', line: 1 },
      { file: 'packages/b/src/y.ts', line: 2 },
      { file: 'packages/daemon/src/assets/shot.ts', line: 1 },
    ]);
    const filtered = scanSources([...SOURCE_GLOBS, BROWSER_AUTOMATION_ALLOWED], BROWSER_AUTOMATION_IMPORT, cwd);
    expect(filtered.map((h) => h.file)).not.toContain('packages/daemon/src/assets/shot.ts');
    expect(filtered).toHaveLength(3);
  });

  it('does not flag unrelated mentions', () => {
    const cwd = fixture({
      'packages/a/src/x.ts': "// we do not use playwright here\nconst s = 'puppeteer';\n",
    });
    expect(scanSources(SOURCE_GLOBS, BROWSER_AUTOMATION_IMPORT, cwd)).toEqual([]);
  });
});

describe('site-read-only and git-allowlist scanners', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'cph scan '));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, name);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content);
    }
    return dir;
  }

  it('site-read-only flags every way of reaching an fs write API, and nothing else', () => {
    const cwd = fixture({
      'packages/a/src/named.ts': "import { readFileSync, writeFileSync } from 'node:fs';\n",
      'packages/a/src/multi.ts': "import {\n  readFile,\n  mkdir as makeDir,\n} from 'node:fs/promises';\n",
      'packages/a/src/plain-fs.ts': "import { rmSync } from 'fs';\n",
      'packages/a/src/ns.ts': "import * as fs from 'node:fs';\n",
      'packages/a/src/default.ts': "import fs from 'node:fs';\n",
      'packages/a/src/req.ts': "const fs = require('node:fs');\n",
      'packages/a/src/dyn.ts': "const fs = await import('node:fs/promises');\n",
      'packages/a/src/member.ts': 'await fs.promises.rm(x);\nfsp.copyFile(a, b);\n',
      'packages/a/src/reexport.ts': "export { rename } from 'node:fs';\n",
      'packages/a/src/ok-reads.ts': [
        "import { readFileSync, readdirSync, existsSync } from 'node:fs';",
        "import { readFile, readdir } from 'node:fs/promises';",
        "import { rm } from './guarded.js';",
        'guardedFs.writeFile(a, b);',
        "const word = 'writeFile';",
        '',
      ].join('\n'),
      'packages/a/src/x.test.ts': "import { writeFileSync } from 'node:fs';\n",
      'packages/a/test/y.ts': "import { writeFileSync } from 'node:fs';\n",
      'packages/daemon/src/site/guarded-fs.ts': "import { writeFile } from 'node:fs/promises';\n",
    });
    const hits = scanSourcesWhole([...SRC_ONLY_GLOBS, SITE_READ_ONLY_ALLOWED], FS_WRITE_IMPORT, cwd);
    expect(hits).toEqual([
      { file: 'packages/a/src/default.ts', line: 1 },
      { file: 'packages/a/src/dyn.ts', line: 1 },
      { file: 'packages/a/src/member.ts', line: 1 },
      { file: 'packages/a/src/member.ts', line: 2 },
      { file: 'packages/a/src/multi.ts', line: 1 },
      { file: 'packages/a/src/named.ts', line: 1 },
      { file: 'packages/a/src/ns.ts', line: 1 },
      { file: 'packages/a/src/plain-fs.ts', line: 1 },
      { file: 'packages/a/src/reexport.ts', line: 1 },
      { file: 'packages/a/src/req.ts', line: 1 },
    ]);
  });

  it('git-allowlist flags git spawns outside git.ts, and inside it any call without --no-optional-locks first', () => {
    const cwd = fixture({
      'packages/a/src/one.ts': "await execFile('git', ['status']);\n",
      'packages/a/src/two.ts': "const r = spawnSync('git', ['log']);\nexec(`git status`);\n",
      'packages/a/src/split.ts': "await execFileAsync(\n  'git',\n  ['log'],\n);\n",
      'packages/a/src/ok.ts': "await execFile('npm', ['i']);\nconst s = \"git is a word\";\n",
      'packages/daemon/src/site/git.ts':
        "execFileAsync('git', ['--no-optional-locks', ...rest], opts);\nexecFileAsync('git', args, opts);\n",
    });
    const outside = scanSourcesWhole([...SRC_ONLY_GLOBS, GIT_ALLOWED], GIT_SPAWN_ANY, cwd);
    expect(outside).toEqual([
      { file: 'packages/a/src/one.ts', line: 1 },
      { file: 'packages/a/src/split.ts', line: 1 },
      { file: 'packages/a/src/two.ts', line: 1 },
      { file: 'packages/a/src/two.ts', line: 2 },
    ]);
    const inside = scanSourcesWhole([GIT_FILE], GIT_SPAWN_ANY, cwd);
    const compliant = scanSourcesWhole([GIT_FILE], GIT_SPAWN_NO_LOCKS_FIRST, cwd);
    expect(inside).toHaveLength(2);
    expect(compliant).toHaveLength(1);
  });
});

describe('source rules', () => {
  it('no-browser-automation: playwright/puppeteer only under packages/daemon/src/assets/', () => {
    const hits = scanSources([...SOURCE_GLOBS, BROWSER_AUTOMATION_ALLOWED], BROWSER_AUTOMATION_IMPORT);
    expect(hits).toEqual([]);
  });

  it('site-read-only: only guarded-fs.ts imports node:fs write APIs (everything else uses guardedFs)', () => {
    const hits = scanSourcesWhole([...SRC_ONLY_GLOBS, SITE_READ_ONLY_ALLOWED], FS_WRITE_IMPORT);
    expect(hits).toEqual([]);
  });

  it('git-allowlist: git is spawned only in site/git.ts, and always with --no-optional-locks first', () => {
    const outside = scanSourcesWhole([...SRC_ONLY_GLOBS, GIT_ALLOWED], GIT_SPAWN_ANY);
    expect(outside).toEqual([]);
    // The rule must still see git.ts spawning git, or a rename would turn it into a no-op.
    const inside = scanSourcesWhole([GIT_FILE], GIT_SPAWN_ANY);
    expect(inside.length).toBeGreaterThan(0);
    const compliant = scanSourcesWhole([GIT_FILE], GIT_SPAWN_NO_LOCKS_FIRST);
    expect(compliant).toHaveLength(inside.length);
  });

  it('verified-mint-only-in-gate: only the approval gate mints a VerifiedApproval', () => {
    const outside = scanSources([...SRC_ONLY_GLOBS, ...MINT_FILES.map((f) => `!${f}`)], MINT_VERIFIED);
    expect(outside).toEqual([]);
    // Non-vacuous: the gate must still be the one minting it.
    expect(scanSources(['packages/daemon/src/gate/approval-gate.ts'], MINT_VERIFIED).length).toBeGreaterThan(0);
  });

  it('approved-only-from-gate: approvals.setStatus(..., "approved") only in approval-gate.ts, after presence.verify', () => {
    const outside = scanSourcesWhole([...SRC_ONLY_GLOBS, `!${GATE_FILE}`], SET_APPROVED);
    expect(outside).toEqual([]);
    const indirect = scanSourcesWhole([...SRC_ONLY_GLOBS, `!${GATE_FILE}`, `!${REPOS_FILE}`], SET_STATUS_NOT_LITERAL);
    expect(indirect).toEqual([]);

    // Non-vacuous: the gate must still be the one setting 'approved' ...
    expect(scanSourcesWhole([GATE_FILE], SET_APPROVED)).toHaveLength(1);
    // ... and only after the presence check has returned inside the same file.
    const gate = readFileSync(join(repoRoot, GATE_FILE), 'utf8');
    const verifyAt = gate.indexOf('this.presence.verify(');
    const approvedAt = gate.search(new RegExp(SET_APPROVED.source));
    expect(verifyAt).toBeGreaterThan(-1);
    expect(approvedAt).toBeGreaterThan(verifyAt);
    // The only other way to a row with status 'approved' is insert(); no source file may do that.
    expect(scanSourcesWhole(SRC_ONLY_GLOBS, /\bstatus\s*:\s*['"`]approved['"`]/g)).toEqual([]);
  });

  it('devto-publish-only: the live flag appears only inside DevtoRoute.publish in routes/devto.ts', () => {
    const hits = codeHits(SRC_ONLY_GLOBS, DEVTO_LIVE_FLAG);
    // Non-vacuous: the one allowed place must still hold it.
    expect(hits.length).toBeGreaterThan(0);
    const where = hits.map(({ file, line }) => ({
      file,
      member: enclosingClassMember(readFileSync(join(repoRoot, file), 'utf8'), line),
    }));
    expect(where).toEqual(hits.map(() => ({ file: DEVTO_ROUTE_FILE, member: 'DevtoRoute.publish' })));
  });

  it('buffer-sharenow-only: shareNow appears only inside BufferRoute.publish in routes/buffer.ts', () => {
    const hits = bufferCodeHits(SRC_ONLY_GLOBS, BUFFER_SHARE_NOW);
    // Non-vacuous: the one allowed place must still hold it.
    expect(hits.length).toBeGreaterThan(0);
    const where = hits.map(({ file, line }) => ({
      file,
      member: enclosingClassMember(readFileSync(join(repoRoot, file), 'utf8'), line),
    }));
    expect(where).toEqual(hits.map(() => ({ file: BUFFER_ROUTE_FILE, member: 'BufferRoute.publish' })));
  });

  it('buffer-queue-needs-draft: every object literal with addToQueue also has saveToDraft: true', () => {
    const hits = bufferCodeHits(SRC_ONLY_GLOBS, BUFFER_ADD_TO_QUEUE);
    expect(hits.length).toBeGreaterThan(0); // the stage must still use it
    const bad = hits.filter(({ file, line }) => {
      const source = readFileSync(join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n');
      const literal = enclosingObjectLiteral(source, offsetOnLine(source, line, BUFFER_ADD_TO_QUEUE));
      return literal === undefined || !SAVE_TO_DRAFT_TRUE.test(literal);
    });
    expect(bad).toEqual([]);
  });

  it('no-buffer-mcp: the hosted Buffer MCP host appears nowhere in packages/', () => {
    expect(scanSources(ALL_PACKAGE_FILES, BUFFER_MCP_HOST)).toEqual([]);
  });

  it('the buffer rules see what they should', () => {
    const literalAround = (source: string): string => enclosingObjectLiteral(source, source.indexOf('addToQueue')) ?? '';
    expect(SAVE_TO_DRAFT_TRUE.test(literalAround("call({ a: 1, mode: 'addToQueue', saveToDraft: true });"))).toBe(true);
    expect(SAVE_TO_DRAFT_TRUE.test(literalAround("call({ mode: 'addToQueue', saveToDraft: flag });"))).toBe(false);
    expect(SAVE_TO_DRAFT_TRUE.test(literalAround("a({ saveToDraft: true });\nb({ mode: 'addToQueue' });"))).toBe(false);
    // Nested braces: the innermost literal is the one that counts.
    expect(SAVE_TO_DRAFT_TRUE.test(literalAround("x({ saveToDraft: true, m: { mode: 'addToQueue' } });"))).toBe(false);
    expect(enclosingObjectLiteral("const mode = 'addToQueue';", 14)).toBeUndefined();
    expect(offsetOnLine('a\nb addToQueue\n', 2, BUFFER_ADD_TO_QUEUE)).toBe(4);
    expect(UNION_MEMBER_LINE.test("  mode: 'shareNow' | 'customScheduled' | 'addToQueue';")).toBe(true);
    expect(UNION_MEMBER_LINE.test("  mode: 'shareNow',")).toBe(false);
    expect(BUFFER_MCP_HOST.test('https://MCP.Buffer.com/mcp')).toBe(true);
    expect(BUFFER_MCP_HOST.test('https://api.buffer.com')).toBe(false);
  });

  it('enclosingClassMember names the method around a line, and nothing outside methods', () => {
    const source = [
      "const a = { published: true };", // 1
      'export class Route {', //           2
      '  readonly kind = 1;', //           3
      '  async stage(d: D): Promise<R> {', // 4
      '    const x = { ok: 1 };', //       5
      '    return x;', //                  6
      '  }', //                            7
      '  async publish(d: D, a: A): Promise<P> {', // 8
      '    if (d) {', //                   9
      '      return { published: true };', // 10
      '    }', //                          11
      '  }', //                            12
      '  #helper(p: P) {', //              13
      '    return p;', //                  14
      '  }', //                            15
      '}', //                              16
      'function after() {', //             17
      '  return { published: true };', //  18
      '}', //                              19
    ].join('\n');
    expect(enclosingClassMember(source, 1)).toBeUndefined();
    expect(enclosingClassMember(source, 5)).toBe('Route.stage');
    expect(enclosingClassMember(source, 10)).toBe('Route.publish');
    expect(enclosingClassMember(source, 14)).toBe('Route.#helper');
    expect(enclosingClassMember(source, 18)).toBeUndefined();
  });

  it('the approved-only-from-gate patterns see what they should', () => {
    const hit = (re: RegExp, text: string): boolean => new RegExp(re.source).test(text);
    expect(hit(SET_APPROVED, "this.repos.approvals.setStatus(id, 'approved', { from: 'pending' })")).toBe(true);
    expect(hit(SET_APPROVED, "approvals.setStatus(\n  id,\n  'approved',\n)")).toBe(true);
    expect(hit(SET_APPROVED, "approvals.setStatus(id, 'denied', { from: 'pending' })")).toBe(false);
    expect(hit(SET_STATUS_NOT_LITERAL, 'approvals.setStatus(id, next)')).toBe(true);
    expect(hit(SET_STATUS_NOT_LITERAL, "approvals.setStatus(id, 'expired', { from: 'pending' })")).toBe(false);
  });
});

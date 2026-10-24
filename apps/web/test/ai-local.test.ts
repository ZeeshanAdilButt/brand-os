import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installContext, type AppContext } from '../src/server/context';
import { forOwner } from '../src/server/data/tenant';
import { ensureLocalOwner, LOCAL_OWNER_ID } from '../src/server/data/users';
import type { DbHandle } from '../src/server/db/client';
import { handleContextPreview, handleProviderCreate, handleTaskCreate, handleTaskGet, type AiHandlerDeps } from '../src/server/http/ai-handlers';
import { memoryDb, testConfig } from './helpers';

const APP = 'http://localhost:3100';
const req = (method: string, p: string, body?: unknown) =>
  new Request(`${APP}${p}`, {
    method,
    headers: { host: 'localhost:3100', ...(method === 'GET' ? {} : { origin: APP, 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;

const PRIVATE_TEXT = 'Internal result: batching cut the synthetic queue wait by 41 units.';
const SELECTED = 'We measured the queue wait under load and the queue wait grew.';
const BODY = `# Notes\n\n${SELECTED}\n\nMore.\n`;

let handle: DbHandle;
let uninstall: () => void;
const jobs: Promise<void>[] = [];
const deps = (fetchFn: typeof fetch): AiHandlerDeps => ({ schedule: (job) => void jobs.push(job()), ai: { fetchFn } });
const settle = async () => {
  while (jobs.length) await Promise.allSettled(jobs.splice(0));
};

/** A pretend Ollama: OpenAI chat-completions shape, no key needed. */
function ollama(answer: string) {
  const seen: { url: string; messages: { role: string; content: string }[] }[] = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), messages: (JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }).messages });
    return new Response(JSON.stringify({ model: 'llama-test', choices: [{ message: { content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }), { status: 200 });
  }) as typeof fetch;
  return { fn, seen };
}

beforeAll(async () => {
  handle = await memoryDb();
  await ensureLocalOwner(handle.db);
  const ctx: AppContext = { config: testConfig(), db: handle.db, auth: null };
  uninstall = installContext(ctx);
  await forOwner(LOCAL_OWNER_ID, handle.db).items.create({
    kind: 'note', title: 'Queue wait result', body: PRIVATE_TEXT, tags: [], sourceId: null, sourceDate: null,
    verificationStatus: 'verified', confidence: 'high', confidentiality: 'private', publicUsePermitted: false,
  });
});

afterAll(async () => {
  uninstall();
  await handle.close();
});

describe('a local model keeps text on this machine', () => {
  it('may use private knowledge without an approval, because nothing leaves the network', async () => {
    const provider = await json(await handleProviderCreate(req('POST', '/api/ai/providers', { kind: 'local', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama-test' })));
    expect(provider.trust).toBe('local');
    const article = await forOwner(LOCAL_OWNER_ID, handle.db).articles.create({ title: 'Queue notes', slug: 'queue-notes', bodyMarkdown: BODY });
    const start = BODY.indexOf(SELECTED);
    const selection = { start, end: start + SELECTED.length, text: SELECTED };
    const input = { articleId: article.id, kind: 'improve_section', expectedRevision: article.revision, selection };

    const preview = await json(await handleContextPreview(req('POST', '/api/ai/context-preview', input), deps(ollama('{}').fn)));
    expect(preview).toMatchObject({ trust: 'local', leavesMachine: false, withheld: [] });
    expect(preview.prompt).toContain(PRIVATE_TEXT);

    const model = ollama(JSON.stringify({ operations: [{ type: 'replace_range', original: SELECTED, proposed: 'We measured queue wait under load; it grew.', rationale: 'Shorter.' }] }));
    const started = await handleTaskCreate(req('POST', '/api/ai/tasks', input), deps(model.fn));
    expect(started.status).toBe(201);
    const startedBody = await json(started);
    await settle();
    expect(model.seen[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(model.seen[0]?.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(model.seen[0]?.messages[1]?.content).toContain(PRIVATE_TEXT);
    const task = await json(await handleTaskGet(req('GET', `/api/ai/tasks/${startedBody.id}`), startedBody.id, deps(model.fn)));
    expect(task).toMatchObject({ status: 'needs_review', usage: { tokensIn: 50, tokensOut: 10, estimated: false }, notes: [{ viaApproval: false }] });
  });
});

describe('source rules for AI code', () => {
  const root = path.resolve(import.meta.dirname, '../src');
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const all = files(root).map((f) => ({ file: path.relative(root, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));
  const aiCode = all.filter((f) => f.file.startsWith('server/ai/') || /^server\/actions\/ai-/.test(f.file) || f.file.startsWith('server/http/ai-') || f.file.startsWith('server/http/agent'));

  it('never logs from the code that handles provider keys or task text', () => {
    expect(aiCode.length).toBeGreaterThan(10);
    const offenders = aiCode.filter((f) => /\bconsole\.(log|info|debug|warn|error)\b/.test(f.text) && !/defaultSchedule|agent api handler failed/.test(f.text)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it('only logs the name of an error, never its message, where it logs at all', () => {
    for (const f of aiCode) {
      for (const match of f.text.matchAll(/console\.error\(([^)]*)\)/g)) expect(match[1], f.file).toMatch(/\.name|'unknown error'/);
    }
  });

  it('never reads a provider key from the environment: the app calls only providers the person set up', () => {
    const offenders = all.filter((f) => /process\.env\.(ANTHROPIC|OPENAI|OLLAMA)\w*/.test(f.text)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it('reaches Anthropic only through its adapter and the one address constant', () => {
    const offenders = all.filter((f) => /api\.anthropic\.com/.test(f.text) && !['lib/ai.ts'].includes(f.file)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it('only the key module touches key encryption or spawns a process', () => {
    expect(all.filter((f) => /child_process/.test(f.text)).map((f) => f.file)).toEqual(['server/ai/crypto.ts']);
    expect(all.filter((f) => /createCipheriv|createDecipheriv/.test(f.text)).map((f) => f.file)).toEqual(['server/ai/crypto.ts']);
  });

  it('keeps the encrypted key out of every module except the ones that store, read or seal it', () => {
    const allowed = ['server/actions/ai-providers.ts', 'server/actions/ai-tasks.ts', 'server/ai/runtime.ts', 'server/data/ai-providers.ts', 'server/db/schema.ts', 'server/ai/crypto.ts', 'server/actions/publishing.ts', 'server/data/publishing.ts', 'server/publishing/registry.ts', 'server/actions/connect.ts', 'server/connect/tokens.ts', 'server/data/connect.ts'];
    const users = all.filter((f) => /encryptedKey/.test(f.text)).map((f) => f.file);
    expect(users.filter((f) => !allowed.includes(f))).toEqual([]);
  });
});

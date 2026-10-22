/**
 * Runs the three platform fakes (DEV.to, Hashnode, GitHub) from the test helpers on local ports, for trying the
 * built app by hand. Everything listens on 127.0.0.1 only and nothing reaches the network.
 *
 *   FAKE_DEVTO_KEY=<any> FAKE_HASHNODE_KEY=<any> FAKE_GITHUB_KEY=<any> pnpm exec tsx apps/web/test/helpers/fake-platforms-cli.ts
 *
 * Then start the app with the test-only address overrides (see INTEGRATIONS.md):
 *
 *   CPH_ALLOW_TEST_PLATFORM_URLS=1 CPH_TEST_DEVTO_URL=http://127.0.0.1:4731 \
 *   CPH_TEST_HASHNODE_URL=http://127.0.0.1:4732 CPH_TEST_GITHUB_URL=http://127.0.0.1:4733 ...
 *
 * The keys are whatever you choose here. Each one is accepted only by its own fake. Requests are printed without
 * any key so a run can be followed. Set FAKE_FAIL_ONCE=devto-publish to see one refused publish and a retry.
 */
import http from 'node:http';
import { createFakeDevto, serveFakeDevto } from './fake-devto';
import { createFakeGithub, serveFakeGithub } from './fake-github';
import { createFakeHashnode } from './fake-hashnode';

const need = (name: string) => {
  const value = process.env[name] ?? '';
  if (!value) {
    console.error(`Set ${name} to the key you will paste into Platforms > Integrations.`);
    process.exit(1);
  }
  return value;
};

const devtoPort = Number(process.env.FAKE_DEVTO_PORT ?? '4731');
const hashnodePort = Number(process.env.FAKE_HASHNODE_PORT ?? '4732');
const githubPort = Number(process.env.FAKE_GITHUB_PORT ?? '4733');

const devto = createFakeDevto({ apiKey: need('FAKE_DEVTO_KEY'), origin: `http://127.0.0.1:${devtoPort}` });
const hashnode = createFakeHashnode({ token: need('FAKE_HASHNODE_KEY'), origin: `http://127.0.0.1:${hashnodePort}/` });
const github = createFakeGithub({ token: need('FAKE_GITHUB_KEY'), repo: 'example-owner/example-site', baseBranch: 'main', origin: `http://127.0.0.1:${githubPort}` });

if (process.env.FAKE_FAIL_ONCE === 'devto-publish') {
  devto.inject({ match: /PUT \/api\/articles\/\d+/, status: 422, body: { error: 'Validation failed: canonical url is not allowed in this test.' }, times: 1 });
}

await serveFakeDevto(devto, devtoPort);
await serveFakeGithub(github, githubPort);

// The Hashnode fake answers through an injected fetch, so give it a thin HTTP front.
http
  .createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const init: RequestInit = { method: req.method ?? 'POST', headers };
      if (chunks.length > 0) init.body = Buffer.concat(chunks);
      hashnode.fetch(`http://127.0.0.1:${hashnodePort}${req.url ?? '/'}`, init).then(
        async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        },
        () => {
          res.writeHead(502);
          res.end();
        },
      );
    });
  })
  .listen(hashnodePort, '127.0.0.1');

console.log(`fake DEV.to    http://127.0.0.1:${devtoPort}`);
console.log(`fake Hashnode  http://127.0.0.1:${hashnodePort}`);
console.log(`fake GitHub    http://127.0.0.1:${githubPort}  (repo example-owner/example-site, base main)`);

const stamp = () => new Date().toISOString();
setInterval(() => {
  while (devto.requests.length > 0) {
    const r = devto.requests.shift()!;
    const body = r.body && typeof r.body === 'object' ? (r.body as { article?: { title?: string; published?: boolean } }).article : undefined;
    console.log(`${stamp()} devto    ${r.method} ${r.path}${body ? ` published=${String(body.published)}` : ''}`);
  }
  while (hashnode.requests.length > 0) {
    const r = hashnode.requests.shift()!;
    console.log(`${stamp()} hashnode ${/(?:query|mutation)\s+(\w+)/.exec(r.query)?.[1] ?? '?'}`);
  }
  while (github.requests.length > 0) {
    const r = github.requests.shift()!;
    console.log(`${stamp()} github   ${r.method} ${r.path}`);
  }
}, 500);

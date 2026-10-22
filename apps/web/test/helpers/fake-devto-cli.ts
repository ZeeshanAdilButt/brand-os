/**
 * Runs the fake DEV.to server from the test helpers on a local port, for trying the built app by hand.
 *
 *   FAKE_DEVTO_PORT=4731 FAKE_DEVTO_KEY=<any string> pnpm exec tsx apps/web/test/helpers/fake-devto-cli.ts
 *
 * Then start the app with the test-only address override (see INTEGRATIONS.md):
 *
 *   CPH_ALLOW_TEST_PLATFORM_URLS=1 CPH_TEST_DEVTO_URL=http://127.0.0.1:4731 ...
 *
 * It listens on 127.0.0.1 only and never reaches the network. The key is whatever you choose here.
 */
import { createFakeDevto, serveFakeDevto } from './fake-devto';

const port = Number(process.env.FAKE_DEVTO_PORT ?? '4731');
const apiKey = process.env.FAKE_DEVTO_KEY ?? '';
if (!apiKey) {
  console.error('Set FAKE_DEVTO_KEY to the key you will paste into Platforms > Integrations.');
  process.exit(1);
}

const fake = createFakeDevto({ apiKey, origin: `http://127.0.0.1:${port}` });
await serveFakeDevto(fake, port);
console.log(`fake DEV.to listening on http://127.0.0.1:${port}`);

// Print what the app sent, without the key, so a run can be followed.
setInterval(() => {
  while (fake.requests.length > 0) {
    const r = fake.requests.shift()!;
    const body = r.body && typeof r.body === 'object' ? (r.body as { article?: { title?: string; published?: boolean } }).article : undefined;
    console.log(`${new Date().toISOString()} ${r.method} ${r.path}${body ? ` published=${String(body.published)} title=${JSON.stringify(body.title)}` : ''}`);
  }
}, 500);

// Post-build step: `tsc` emits only .js/.d.ts, so non-TypeScript runtime files are copied by hand.
// Today that is gate/hello.ps1, which WindowsHelloPresence finds next to its own module, and the
// vendored http/static/htmx.min.js and the http/static/app.css stylesheet, which the dashboard
// serves from next to its own module.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE_ASSETS = ['hello.ps1'];
const STATIC_ASSETS = ['htmx.min.js', 'app.css'];

/** Copies `<root>/src/gate/<asset>` to `<root>/dist/gate/<asset>`. Throws if an asset is missing. */
export function copyGateAssets(root) {
  const from = join(root, 'src', 'gate');
  const to = join(root, 'dist', 'gate');
  mkdirSync(to, { recursive: true });
  for (const name of GATE_ASSETS) copyFileSync(join(from, name), join(to, name));
}

/** Copies `<root>/src/http/static/<asset>` to `<root>/dist/http/static/<asset>`. Throws if an asset is missing. */
export function copyStaticAssets(root) {
  const from = join(root, 'src', 'http', 'static');
  const to = join(root, 'dist', 'http', 'static');
  mkdirSync(to, { recursive: true });
  for (const name of STATIC_ASSETS) copyFileSync(join(from, name), join(to, name));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  copyGateAssets(root);
  copyStaticAssets(root);
}

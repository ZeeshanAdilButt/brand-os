import path from 'node:path';
import type { NextConfig } from 'next';
import { loadEnvConfig } from '@next/env';

// One .env at the repository root serves the whole workspace. Local mode needs none.
const repoRoot = path.resolve(process.cwd(), '../..');
loadEnvConfig(repoRoot);

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The embedded database is a WASM module with a native-style data directory; keep it out of the bundle.
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default config;

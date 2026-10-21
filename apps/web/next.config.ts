import path from 'node:path';
import type { NextConfig } from 'next';
import { loadEnvConfig } from '@next/env';

// One .env at the repository root serves the whole workspace. Local mode needs none.
const repoRoot = path.resolve(process.cwd(), '../..');
loadEnvConfig(repoRoot);

const config: NextConfig = {
  // A second build folder lets a build run next to a dev server that is using .next (set NEXT_DIST_DIR=.next-alt).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  // The embedded database is a WASM module with a native-style data directory; keep it out of the bundle.
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default config;

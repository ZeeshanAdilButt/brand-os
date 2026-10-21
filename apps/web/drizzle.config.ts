import { defineConfig } from 'drizzle-kit';

// Used only to generate SQL migrations (pnpm --filter @cph/web db:generate). The schema is
// dialect-identical for PGlite and Postgres, so one migration set serves both drivers.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
});

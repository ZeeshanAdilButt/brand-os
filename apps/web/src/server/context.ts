import { createAuth, type Auth } from './auth';
import { loadConfig, type AppConfig } from './config';
import { getDb } from './db';
import type { AppDb } from './db/client';

/** Everything a request needs from the server: validated config, the database and (hosted) sign-in. */
export interface AppContext {
  config: AppConfig;
  db: AppDb;
  /** Present in hosted mode only. Local mode has no sign-in. */
  auth: Auth | null;
}

const globalForCtx = globalThis as typeof globalThis & {
  __cphAuth?: Auth;
  /** Tests install a context here; production never sets it. */
  __cphContextOverride?: AppContext;
};

export async function getAppContext(): Promise<AppContext> {
  if (globalForCtx.__cphContextOverride) return globalForCtx.__cphContextOverride;
  const config = loadConfig();
  const handle = await getDb();
  if (config.mode === 'local') return { config, db: handle.db, auth: null };
  globalForCtx.__cphAuth ??= createAuth(handle.db, config);
  return { config, db: handle.db, auth: globalForCtx.__cphAuth };
}

/** Test seam: serve this context from getAppContext until the returned function is called. */
export function installContext(ctx: AppContext): () => void {
  globalForCtx.__cphContextOverride = ctx;
  return () => {
    delete globalForCtx.__cphContextOverride;
  };
}

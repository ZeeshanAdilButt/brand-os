import { z } from 'zod';

export type Mode = 'local' | 'hosted';
export type DbDriver = 'pglite' | 'postgres';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const envSchema = z.object({
  MODE: z.enum(['local', 'hosted']).default('local'),
  DATABASE_URL: z.string().trim().min(1).optional(),
  DATA_DIR: z.string().trim().min(1).default('./.data'),
  APP_URL: z.url().default('http://localhost:3100'),
  AUTH_SECRET: z.string().min(1).optional(),
  OWNER_USER_ID: z.uuid().optional(),
});

export interface AppConfig {
  mode: Mode;
  /** Local mode uses embedded PGlite; hosted mode uses a real Postgres server. Never mixed. */
  driver: DbDriver;
  dataDir: string;
  databaseUrl: string | undefined;
  /** Public origin of the app. Sets cookie security and the trusted origin for sign-in requests. */
  appUrl: string;
  /** Hosted mode: secret for signing sessions. Checked when sign-in starts, not at config load. */
  authSecret: string | undefined;
  /** Hosted mode: the user id designated as owner (the only user the private seed may write to). */
  ownerUserId: string | undefined;
}

/** Parse the process environment into a validated config. Throws ConfigError with an actionable message. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse({
    MODE: emptyToUndefined(env.MODE),
    DATABASE_URL: emptyToUndefined(env.DATABASE_URL),
    DATA_DIR: emptyToUndefined(env.DATA_DIR),
    APP_URL: emptyToUndefined(env.APP_URL),
    AUTH_SECRET: emptyToUndefined(env.AUTH_SECRET),
    OWNER_USER_ID: emptyToUndefined(env.OWNER_USER_ID),
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment (${problems}). See .env.example.`);
  }
  const { MODE, DATABASE_URL, DATA_DIR, APP_URL, AUTH_SECRET, OWNER_USER_ID } = parsed.data;
  if (MODE === 'hosted' && !DATABASE_URL) {
    throw new ConfigError('MODE=hosted requires DATABASE_URL (a PostgreSQL connection string). See .env.example.');
  }
  return {
    mode: MODE,
    driver: MODE === 'hosted' ? 'postgres' : 'pglite',
    dataDir: DATA_DIR,
    databaseUrl: MODE === 'hosted' ? DATABASE_URL : undefined,
    appUrl: APP_URL.replace(/\/+$/, ''),
    authSecret: MODE === 'hosted' ? AUTH_SECRET : undefined,
    ownerUserId: MODE === 'hosted' ? OWNER_USER_ID : undefined,
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { ConfigError, type AppConfig } from '../config';
import type { AppDb } from '../db/client';
import { accounts, sessions, users, verifications } from '../db/schema';

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;
const MIN_SECRET_LENGTH = 32;
const SESSION_SECONDS = 60 * 60 * 24 * 14;

/**
 * Hosted-mode sign-in. Email and password only, no third-party service: Better Auth running on our
 * own tables. Passwords are salted scrypt hashes. The session is an opaque random token in an
 * httpOnly, SameSite=Lax cookie (Secure when APP_URL is https); the server stores the session row,
 * so signing out or deleting a user revokes it immediately. Better Auth rejects cross-origin
 * mutating requests (Origin must match APP_URL).
 */
export function createAuth(db: AppDb, config: AppConfig) {
  const secret = config.authSecret;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(
      `MODE=hosted requires AUTH_SECRET of at least ${MIN_SECRET_LENGTH} characters (a long random value). See .env.example.`,
    );
  }
  const https = config.appUrl.startsWith('https://');
  return betterAuth({
    appName: 'Brand OS',
    baseURL: config.appUrl,
    secret,
    trustedOrigins: [config.appUrl],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    user: { fields: { name: 'displayName' } },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      autoSignIn: true,
      // No mail provider exists yet, so a verification step could never complete.
      requireEmailVerification: false,
    },
    session: { expiresIn: SESSION_SECONDS, updateAge: 60 * 60 * 24 },
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: https,
      // Explicit, because Better Auth turns both checks off when NODE_ENV is 'test'.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 8 },
        '/sign-up/email': { window: 60, max: 5 },
      },
    },
    telemetry: { enabled: false },
    // Keep last: lets server actions that call the auth API set the session cookie.
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

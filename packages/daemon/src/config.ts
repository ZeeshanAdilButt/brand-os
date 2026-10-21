import { readFileSync } from 'node:fs';
import { DEFAULT_BASE_URL } from '@cph/core';
import { z } from 'zod';
import { configPath, stateDir } from './paths.js';

export const DEFAULT_REPO_PATH = 'C:\\path\\to\\your-site';
export const DEFAULT_PORT = 4646;

/** The machine's time zone (an IANA name, resolved from the Windows setting by the runtime). */
function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// zod 4: `.prefault({})` feeds `{}` through the inner schema, so nested defaults apply.
export const ConfigSchema = z.object({
  site: z
    .object({
      repoPath: z.string().min(1).default(DEFAULT_REPO_PATH),
      baseUrl: z.url().default(DEFAULT_BASE_URL),
      timeZone: z.string().min(1).default(systemTimeZone),
    })
    .prefault({}),
  daemon: z
    .object({
      port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
    })
    .prefault({}),
  approval: z
    .object({
      /**
       * How the dashboard's Approve is confirmed: 'click' (the click itself is the human action, for PCs
       * without Windows Hello) or 'hello' (Windows Hello in the daemon's process).
       */
      mode: z.enum(['hello', 'click']).default('click'),
    })
    .prefault({}),
  claude: z
    .object({
      askOnPublish: z.boolean().default(true),
    })
    .prefault({}),
  platforms: z
    .object({
      devto: z.object({ tagPreference: z.array(z.string()).optional() }).optional(),
      linkedin: z
        .object({
          route: z.enum(['buffer', 'assist']),
          bufferChannelId: z.string().optional(),
          /** Off until spike S2(e) confirms the link attachment fields. */
          linkCard: z.boolean().default(false),
        })
        .optional(),
      buffer: z.object({ organizationId: z.string().optional() }).optional(),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface LoadConfigOptions {
  /** Directory holding config.json. Defaults to `stateDir()`. */
  stateDir?: string;
  /** Explicit file; wins over `stateDir`. */
  path?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Reads config.json and applies defaults. A missing file gives pure defaults and is NOT
 * written back: `cph install` creates it later.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const file = options.path ?? configPath(options.stateDir ?? stateDir());
  let raw: unknown = {};
  let text: string | undefined;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigError(`cannot read ${file}: ${(err as Error).message}`);
    }
  }
  if (text !== undefined) {
    try {
      raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (err) {
      throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`);
    }
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ConfigError(`${file} is invalid: ${issues}`);
  }
  return parsed.data;
}

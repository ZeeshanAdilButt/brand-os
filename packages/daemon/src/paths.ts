import { homedir } from 'node:os';
import { join } from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * `%LOCALAPPDATA%\content-powerhouse`, or `CPH_STATE_DIR` when set (tests always set it to a
 * temp dir). This only computes the path; nothing is created here.
 */
export function stateDir(env: Env = process.env): string {
  const override = env['CPH_STATE_DIR'];
  if (override !== undefined && override !== '') return override;
  const localAppData = env['LOCALAPPDATA'];
  const base = localAppData !== undefined && localAppData !== '' ? localAppData : join(homedir(), 'AppData', 'Local');
  return join(base, 'content-powerhouse');
}

export function dbPath(dir: string = stateDir()): string {
  return join(dir, 'cph.db');
}

export function configPath(dir: string = stateDir()): string {
  return join(dir, 'config.json');
}

import type { FileOps } from '../context.js';

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ConfigFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigFileError';
  }
}

/** `2026-10-20T10-11-12Z`: sortable and valid in a Windows file name. */
export function backupStamp(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

/** Parses an existing JSON file (BOM tolerated). A file that is not a JSON object is never overwritten. */
export function parseJsonObject(text: string, path: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new ConfigFileError(`${path} is not valid JSON (${(error as Error).message}); fix or remove it, then run install again`);
  }
  if (!isObject(value)) throw new ConfigFileError(`${path} is not a JSON object; fix or remove it, then run install again`);
  return value;
}

export interface MergeOutcome {
  path: string;
  changed: boolean;
  created: boolean;
  backup?: string;
}

/**
 * Reads `path`, applies `merge` to the parsed object and, only when it changed something, writes a
 * timestamped `.bak` of the old file and then the merged JSON. An unchanged file is left alone, so
 * running twice leaves one entry and one backup.
 */
export function mergeJsonFile(
  files: FileOps,
  path: string,
  now: Date,
  merge: (current: JsonObject) => { next: JsonObject; changed: boolean },
): MergeOutcome {
  const existing = files.readText(path);
  const current = existing === null || existing.trim() === '' ? {} : parseJsonObject(existing, path);
  const { next, changed } = merge(current);
  if (!changed) return { path, changed: false, created: false };
  const outcome: MergeOutcome = { path, changed: true, created: existing === null };
  if (existing !== null) {
    const backup = `${path}.${backupStamp(now)}.bak`;
    files.writeFile(backup, existing);
    outcome.backup = backup;
  }
  files.writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  return outcome;
}

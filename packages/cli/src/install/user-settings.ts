import { join } from 'node:path';
import type { FileOps } from '../context.js';
import { ConfigFileError, isObject, mergeJsonFile, type JsonObject, type MergeOutcome } from './json-merge.js';

export const ASK_RULES = ['mcp__content-powerhouse__publish', 'mcp__content-powerhouse__schedule'] as const;

/**
 * Regex over tool names (Claude Code treats a matcher with characters beyond letters, digits, `_`,
 * `-`, space, `,` and `|` as an unanchored JavaScript regex).
 */
export const GUARD_MATCHER = 'mcp__claude-in-chrome__.*|mcp__Claude_Browser__.*|mcp__computer-use__.*|mcp__terminal__.*|Bash|PowerShell|Monitor';

const GUARD_MARKER = 'cph-guard.mjs';

export function userSettingsPath(homeDir: string): string {
  return join(homeDir, '.claude', 'settings.json');
}

export function guardScriptPath(repoRoot: string): string {
  return join(repoRoot, 'packages', 'cli', 'hooks', GUARD_MARKER);
}

export function guardCommand(repoRoot: string): string {
  return `node "${guardScriptPath(repoRoot)}"`;
}

export interface UserSettingsOptions {
  guardCommand: string;
  /** `claude.askOnPublish`; false skips the permissions.ask entries. */
  askOnPublish: boolean;
}

function hookEntry(command: string): JsonObject {
  return { matcher: GUARD_MATCHER, hooks: [{ type: 'command', command }] };
}

function isGuardHook(hook: unknown): boolean {
  return isObject(hook) && typeof hook['command'] === 'string' && hook['command'].includes(GUARD_MARKER);
}

/**
 * Pure merge into the parsed `~/.claude/settings.json`. Adds the ask rules that are missing, and
 * adds (or, if the repo moved, updates in place) the one cph-guard PreToolUse entry. Every other
 * key, permission list and hook is carried over untouched.
 */
export function mergeUserSettings(current: JsonObject, options: UserSettingsOptions): { next: JsonObject; changed: boolean } {
  let changed = false;
  const next: JsonObject = { ...current };

  if (options.askOnPublish) {
    const permissionsValue = current['permissions'];
    if (permissionsValue !== undefined && !isObject(permissionsValue)) {
      throw new ConfigFileError('permissions in settings.json is not an object; fix it, then run install again');
    }
    const permissions: JsonObject = { ...(permissionsValue ?? {}) };
    const askValue = permissions['ask'];
    if (askValue !== undefined && !Array.isArray(askValue)) {
      throw new ConfigFileError('permissions.ask in settings.json is not an array; fix it, then run install again');
    }
    const ask: unknown[] = [...(askValue ?? [])];
    for (const rule of ASK_RULES) {
      if (!ask.includes(rule)) {
        ask.push(rule);
        changed = true;
      }
    }
    if (changed) {
      permissions['ask'] = ask;
      next['permissions'] = permissions;
    }
  }

  const hooksValue = current['hooks'];
  if (hooksValue !== undefined && !isObject(hooksValue)) {
    throw new ConfigFileError('hooks in settings.json is not an object; fix it, then run install again');
  }
  const preValue = hooksValue?.['PreToolUse'];
  if (preValue !== undefined && !Array.isArray(preValue)) {
    throw new ConfigFileError('hooks.PreToolUse in settings.json is not an array; fix it, then run install again');
  }
  const pre: unknown[] = [...(preValue ?? [])];
  const index = pre.findIndex((entry) => isObject(entry) && Array.isArray(entry['hooks']) && entry['hooks'].some(isGuardHook));
  const wanted = hookEntry(options.guardCommand);
  if (index === -1) {
    pre.push(wanted);
    changed = true;
  } else {
    const existing = pre[index] as JsonObject;
    const others = (existing['hooks'] as unknown[]).filter((h) => !isGuardHook(h));
    const updated: JsonObject = { ...existing, matcher: GUARD_MATCHER, hooks: [...(wanted['hooks'] as unknown[]), ...others] };
    if (JSON.stringify(updated) !== JSON.stringify(existing)) {
      pre[index] = updated;
      changed = true;
    }
  }
  if (changed) next['hooks'] = { ...(hooksValue ?? {}), PreToolUse: pre };

  return { next, changed };
}

export function registerUserSettings(files: FileOps, homeDir: string, options: UserSettingsOptions, now: Date): MergeOutcome {
  return mergeJsonFile(files, userSettingsPath(homeDir), now, (current) => mergeUserSettings(current, options));
}

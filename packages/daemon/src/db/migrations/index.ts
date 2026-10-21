import { INIT_SQL } from './001_init.js';
import { DRAFT_SOURCE_SQL } from './002_draft_source.js';
import { APPROVAL_CHANNELS_SQL } from './003_approval_channels.js';

export interface Migration {
  /** Becomes `PRAGMA user_version` once applied. Strictly increasing from 1. */
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: INIT_SQL },
  { version: 2, name: 'draft_source', sql: DRAFT_SOURCE_SQL },
  { version: 3, name: 'approval_channels', sql: APPROVAL_CHANNELS_SQL },
];

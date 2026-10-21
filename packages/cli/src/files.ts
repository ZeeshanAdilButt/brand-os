import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { guardedFs } from '@cph/daemon/guarded-fs';
import type { FileOps } from './context.js';

/** Real files. Every write goes through the daemon's guarded fs, which refuses the site repo. */
export function createFileOps(): FileOps {
  return {
    exists: (path) => existsSync(path),
    readText(path) {
      try {
        return readFileSync(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    writeFile(path, data) {
      guardedFs.mkdirSync(dirname(path), { recursive: true });
      guardedFs.writeFileSync(path, data);
    },
    remove(path) {
      guardedFs.rmSync(path, { force: true });
    },
  };
}

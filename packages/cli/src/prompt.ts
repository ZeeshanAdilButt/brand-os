import { createInterface } from 'node:readline';
import type { Prompter } from './context.js';

/** Answers that mean yes. Everything else, including an empty line, is no. */
export function isYes(answer: string): boolean {
  return /^\s*y(?:es)?\s*$/i.test(answer);
}

/**
 * Terminal prompts. `confirm` works on a pipe too (end of input counts as no). `secret` reads
 * keystrokes in raw mode so nothing is echoed.
 */
export function createTerminalPrompter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Prompter {
  // One readline for the whole run: a second one would lose lines the first already buffered.
  let rl: ReturnType<typeof createInterface> | undefined;
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;
  const ensure = (): void => {
    if (rl !== undefined) return;
    rl = createInterface({ input, terminal: false });
    rl.on('line', (line) => {
      const next = waiting.shift();
      if (next) next(line);
      else lines.push(line);
    });
    rl.on('close', () => {
      ended = true;
      for (const next of waiting.splice(0)) next(null);
    });
  };
  const readLine = (): Promise<string | null> => {
    ensure();
    const buffered = lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (ended) return Promise.resolve(null);
    return new Promise((resolve) => waiting.push(resolve));
  };

  return {
    close() {
      rl?.close();
      rl = undefined;
    },
    async confirm(question) {
      output.write(question);
      const answer = await readLine();
      if (answer === null) output.write('\n');
      return answer !== null && isYes(answer);
    },
    secret(question) {
      return new Promise((resolve, reject) => {
        if (!input.isTTY || typeof input.setRawMode !== 'function') {
          reject(new Error('hidden input needs an interactive terminal'));
          return;
        }
        output.write(question);
        let value = '';
        const finish = (): void => {
          input.setRawMode(false);
          input.off('data', onData);
          input.pause();
          output.write('\n');
        };
        const onData = (chunk: Buffer): void => {
          for (const ch of chunk.toString('utf8')) {
            if (ch === '\r' || ch === '\n') {
              finish();
              resolve(value);
              return;
            }
            if (ch === '\u0003') {
              finish();
              reject(new Error('cancelled'));
              return;
            }
            if (ch === '\b' || ch === '\u007f') value = value.slice(0, -1);
            else value += ch;
          }
        };
        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
      });
    },
  };
}

// Vitest setup file, loaded for every project (see vitest.config.ts).
// Tests never touch the network: global fetch throws, and undici (which backs
// Node's fetch and any undici client) refuses every real connection.
import { MockAgent, setGlobalDispatcher } from 'undici';

export class NetworkBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkBlockedError';
  }
}

function describeTarget(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof input === 'object' && input !== null && 'url' in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

globalThis.fetch = (async (input: unknown): Promise<Response> => {
  throw new NetworkBlockedError(`network disabled in tests: ${describeTarget(input)}`);
}) as typeof fetch;

const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);

import { describe, expect, it } from 'vitest';
import { NetworkBlockedError } from './setup/no-network.js';

describe('network guard', () => {
  it('blocks real network', async () => {
    await expect(fetch('https://dev.to/api/users/me')).rejects.toThrow(NetworkBlockedError);
  });

  it('puts the blocked URL in the message', async () => {
    await expect(fetch('https://dev.to/api/users/me')).rejects.toThrow(
      'network disabled in tests: https://dev.to/api/users/me',
    );
  });

  it('also blocks fetch given a URL object or a Request', async () => {
    await expect(fetch(new URL('https://example.com/a'))).rejects.toThrow(NetworkBlockedError);
    await expect(fetch(new Request('https://example.com/b'))).rejects.toThrow(NetworkBlockedError);
  });
});

describe('undici dispatcher guard', () => {
  it('refuses real connections made through undici directly', async () => {
    const { request } = await import('undici');
    await expect(request('https://dev.to/api/users/me')).rejects.toThrow();
  });
});

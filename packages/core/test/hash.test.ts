import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { payloadHash } from '../src/hash.js';
import type { PlatformId, RouteKind } from '../src/ids.js';

interface Input {
  platform: PlatformId;
  account: string;
  route: RouteKind;
  payload: unknown;
  mediaSha256: string[];
  scheduledAt: string | null;
}

const base = (): Input => ({
  platform: 'linkedin',
  account: 'owner',
  route: 'buffer',
  payload: { text: 'Samples cost 1 to 2 bytes.', link: 'https://www.example-blog.dev/blog/x' },
  mediaSha256: ['aa'.repeat(32), 'bb'.repeat(32)],
  scheduledAt: null,
});

describe('payloadHash', () => {
  it('is lowercase hex SHA-256', () => {
    expect(payloadHash(base())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on key order, at any depth', () => {
    const a = base();
    const b: Input = {
      scheduledAt: null,
      mediaSha256: a.mediaSha256,
      payload: { link: 'https://www.example-blog.dev/blog/x', text: 'Samples cost 1 to 2 bytes.' },
      route: 'buffer',
      account: 'owner',
      platform: 'linkedin',
    };
    expect(payloadHash(b)).toBe(payloadHash(a));
  });

  it('changes when one character of payload.text changes', () => {
    const changed = { ...base(), payload: { text: 'Samples cost 1 to 3 bytes.', link: 'https://www.example-blog.dev/blog/x' } };
    expect(payloadHash(changed)).not.toBe(payloadHash(base()));
  });

  it('changes when scheduledAt goes from null to an ISO string', () => {
    expect(payloadHash({ ...base(), scheduledAt: '2026-10-20T09:00:00.000Z' })).not.toBe(payloadHash(base()));
  });

  it('changes when the media order changes', () => {
    const a = base();
    const swapped = { ...a, mediaSha256: [...a.mediaSha256].reverse() };
    expect(payloadHash(swapped)).not.toBe(payloadHash(a));
  });

  it('changes with platform, account and route', () => {
    const h = payloadHash(base());
    expect(payloadHash({ ...base(), platform: 'x' })).not.toBe(h);
    expect(payloadHash({ ...base(), account: 'other' })).not.toBe(h);
    expect(payloadHash({ ...base(), route: 'direct' })).not.toBe(h);
  });

  it('pins one known hash so canonicalization cannot silently drift', () => {
    // sha256 of the RFC 8785 text below (keys sorted, no whitespace, non-ASCII kept as UTF-8).
    const canonical =
      '{"account":"owner","mediaSha256":["' +
      'aa'.repeat(32) +
      '","' +
      'bb'.repeat(32) +
      '"],"payload":{"link":"https://www.example-blog.dev/blog/x","text":"Samples cost 1 to 2 bytes."},' +
      '"platform":"linkedin","route":"buffer","scheduledAt":null}';
    expect(payloadHash(base())).toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'));
    expect(payloadHash(base())).toBe('514e9df17b517dcada81ee5281533cf3f531c13ef3b78dd785d9e771be5e796d');
  });
});

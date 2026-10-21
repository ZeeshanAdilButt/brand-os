import type { Draft, LinkedinPayload } from '@cph/core';
import { describe, expect, it } from 'vitest';
import { GateError } from '../src/gate/errors.js';
import { mintVerifiedApproval, type VerifiedApproval } from '../src/gate/verified.js';
import {
  AssistLinkedinRoute,
  LINKEDIN_ASSIST_CHECKLIST,
  LINKEDIN_FEED_URL,
  validateLinkedinPostUrl,
} from '../src/routes/assist-linkedin.js';

const SHA = 'a'.repeat(64);
const TEXT = 'A post about caching ρ 🙂\r\n\r\nhttps://www.example-blog.dev/blog/fixture  \n#cache';

function draft(over: Partial<Draft<LinkedinPayload>> = {}): Draft<LinkedinPayload> {
  return {
    id: 'draft-1',
    slug: 'fixture',
    platform: 'linkedin',
    account: 'default',
    route: 'assist',
    kind: 'post',
    status: 'approved',
    payload: { text: TEXT },
    payloadSha256: SHA,
    authorship: 'ai-assisted',
    lint: [],
    createdAt: '2026-10-19T10:00:00.000Z',
    updatedAt: '2026-10-19T10:00:00.000Z',
    ...over,
  };
}

function approval(over: Partial<{ draftId: string; payloadSha256: string }> = {}): VerifiedApproval {
  return mintVerifiedApproval({
    approvalId: 'approval-1',
    draftId: over.draftId ?? 'draft-1',
    payloadSha256: over.payloadSha256 ?? SHA,
    mode: 'approve_only',
    scheduledAt: null,
  });
}

function setup(opts: { openFails?: boolean } = {}) {
  const written: string[] = [];
  const opened: string[] = [];
  const route = new AssistLinkedinRoute({
    clipboard: {
      write: (s) => {
        written.push(s);
        return Promise.resolve();
      },
    },
    opener: (url) => {
      opened.push(url);
      return opts.openFails === true ? Promise.reject(new Error('no browser')) : Promise.resolve();
    },
  });
  return { route, written, opened };
}

describe('AssistLinkedinRoute', () => {
  it('is an assist route for linkedin', () => {
    const { route } = setup();
    expect(route.kind).toBe('assist');
    expect(route.platform).toBe('linkedin');
  });

  it('handOff writes the exact text to the clipboard, opens the feed and returns the checklist', async () => {
    const { route, written, opened } = setup();
    const kit = await route.handOff(draft(), approval());
    expect(written).toEqual([TEXT]);
    expect(opened).toEqual(['https://www.linkedin.com/feed/']);
    expect(kit).toEqual({
      copiedText: TEXT,
      openUrl: 'https://www.linkedin.com/feed/',
      checklist: [
        'Click "Start a post"',
        'Paste (Ctrl+V)',
        'Check the link preview',
        'Click Post',
        'Paste the post URL back with record_publication',
      ],
    });
    expect(LINKEDIN_FEED_URL).toBe('https://www.linkedin.com/feed/');
  });

  it('returns a fresh checklist each time', async () => {
    const { route } = setup();
    const kit = await route.handOff(draft(), approval());
    kit.checklist.push('mutated');
    expect(LINKEDIN_ASSIST_CHECKLIST).toHaveLength(5);
  });

  it('handOff refuses a forged approval and touches neither clipboard nor browser', async () => {
    const { route, written, opened } = setup();
    const forged = { approvalId: 'x', draftId: 'draft-1', payloadSha256: SHA, mode: 'approve_only', scheduledAt: null };
    await expect(route.handOff(draft(), forged as unknown as VerifiedApproval)).rejects.toThrow(TypeError);
    expect(written).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('handOff refuses an approval for a different draft', async () => {
    const { route, written, opened } = setup();
    const error = await route.handOff(draft(), approval({ draftId: 'other' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe('NO_APPROVAL');
    expect(written).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('handOff refuses an approval whose hash no longer covers the draft', async () => {
    const { route, written, opened } = setup();
    const error = await route.handOff(draft(), approval({ payloadSha256: 'b'.repeat(64) })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe('HASH_MISMATCH');
    expect(written).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('handOff surfaces an opener failure (the text is already on the clipboard)', async () => {
    const { route, written } = setup({ openFails: true });
    await expect(route.handOff(draft(), approval())).rejects.toThrow('no browser');
    expect(written).toEqual([TEXT]);
  });

  it('publish always throws WRONG_CHANNEL and does nothing', async () => {
    const { route, written, opened } = setup();
    const error = await route.publish(draft(), approval()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe('WRONG_CHANNEL');
    expect(written).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('health is manual_only and the cost is zero', async () => {
    const { route } = setup();
    expect((await route.health('default')).state).toBe('manual_only');
    expect(route.costEstimate(draft())).toBe(0);
  });

  it('has no stage and no checkOnPlatform', () => {
    const { route } = setup();
    expect('stage' in route).toBe(false);
    expect('checkOnPlatform' in route).toBe(false);
  });
});

describe('validateLinkedinPostUrl', () => {
  it('accepts a LinkedIn post URL and returns it normalised', () => {
    expect(validateLinkedinPostUrl('https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000000/')).toBe(
      'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000000/',
    );
    expect(validateLinkedinPostUrl('  https://WWW.LinkedIn.com/posts/someone_fixture-activity-1  ')).toBe(
      'https://www.linkedin.com/posts/someone_fixture-activity-1',
    );
  });

  it.each([
    'https://evil.example',
    'https://evil.example/https://www.linkedin.com/feed/',
    'http://www.linkedin.com/feed/update/urn:li:activity:1/',
    'https://linkedin.com/feed/update/urn:li:activity:1/',
    'https://www.linkedin.com.evil.example/feed/',
    'https://www.linkedin.com@evil.example/feed/',
    'https://user:pw@www.linkedin.com/feed/',
    'https://www.linkedin.com:8443/feed/',
    'javascript:alert(1)',
    'ftp://www.linkedin.com/feed/',
    'not a url',
    '',
  ])('rejects %j', (url) => {
    expect(() => validateLinkedinPostUrl(url)).toThrow();
  });
});

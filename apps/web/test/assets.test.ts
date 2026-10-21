import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as assetGet } from '../src/app/api/assets/[id]/route';
import { AssetRejectedError, cleanFilename, inspectImage, MAX_ASSET_BYTES } from '../src/server/assets/inspect';
import { handleAssetGet, handleAssetUpload } from '../src/server/http/asset-handlers';
import { assertStorageKey, createFilesystemStorage, InvalidStorageKeyError, newStorageKey, type StorageAdapter } from '../src/server/storage';
import { forOwner } from '../src/server/data/tenant';
import { hostedHarness, HOSTED_URL, type HostedHarness, type TestUser } from './hosted-harness';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
const PNG_2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00');
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);
const text = (s: string) => new TextEncoder().encode(s);

const SAFE_SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#c45d35"/></svg>';

describe('image inspection', () => {
  it('decides the type from the bytes', () => {
    expect(inspectImage(PNG).mime).toBe('image/png');
    expect(inspectImage(JPEG).mime).toBe('image/jpeg');
    expect(inspectImage(GIF).mime).toBe('image/gif');
    expect(inspectImage(WEBP).mime).toBe('image/webp');
    expect(inspectImage(text(SAFE_SVG))).toEqual({ mime: 'image/svg+xml', extension: 'svg' });
    expect(inspectImage(text(`\uFEFF<!-- note -->\n${SAFE_SVG}`)).mime).toBe('image/svg+xml');
  });

  it('refuses empty files, other formats and files over the limit', () => {
    const reason = (bytes: Uint8Array) => {
      try {
        inspectImage(bytes);
      } catch (err) {
        return (err as AssetRejectedError).reason;
      }
      return null;
    };
    expect(reason(new Uint8Array())).toBe('empty');
    expect(reason(text('<html><body>hi</body></html>'))).toBe('unsupported');
    expect(reason(text('MZ\x90\x00 an executable'))).toBe('unsupported');
    expect(reason(text('%PDF-1.7'))).toBe('unsupported');
    const big = new Uint8Array(MAX_ASSET_BYTES + 1);
    big.set(PNG);
    expect(reason(big)).toBe('too_large');
    const exactly = new Uint8Array(MAX_ASSET_BYTES);
    exactly.set(PNG);
    expect(reason(exactly)).toBeNull();
  });

  it.each([
    ['a script element', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['an event handler', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ['a foreignObject', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>'],
    ['a javascript: link', '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>'],
    ['an external image', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/x.png"/></svg>'],
    ['an external url()', '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://example.test/p)"/></svg>'],
    ['a stylesheet import', '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.test/a.css";</style></svg>'],
    ['an entity declaration', '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>'],
  ])('refuses an SVG with %s', (_name, svg) => {
    expect(() => inspectImage(text(svg))).toThrow(AssetRejectedError);
  });

  it('accepts an SVG that only references itself', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><g id="a"><rect/></g></defs><use xlink:href="#a"/><rect fill="url(#a)"/></svg>';
    expect(inspectImage(text(svg)).mime).toBe('image/svg+xml');
  });

  it('cleans file names to something safe to show', () => {
    expect(cleanFilename('..\\..\\evil\\shot.png')).toBe('shot.png');
    expect(cleanFilename('/etc/passwd')).toBe('passwd');
    expect(cleanFilename('a"b<c>.png')).toBe('abc.png');
    expect(cleanFilename('....')).toBe('image');
    expect(cleanFilename('')).toBe('image');
  });
});

describe('filesystem storage', () => {
  const owner = '11111111-1111-4111-8111-111111111111';
  let dir: string;
  let storage: StorageAdapter;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cph storage '));
    storage = createFilesystemStorage(path.join(dir, 'assets'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('stores and returns bytes under a generated key, and never overwrites', async () => {
    const key = newStorageKey(owner, 'png');
    expect(key).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
    expect(await storage.get(key)).toBeNull();
    await storage.put(key, PNG);
    expect(Array.from((await storage.get(key))!)).toEqual(Array.from(PNG));
    await expect(storage.put(key, PNG_2)).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'assets', owner))).toBe(true);
    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
    await storage.delete(key);
  });

  it.each([
    '../../etc/passwd',
    '..\\..\\windows\\win.ini',
    `${owner}/../${owner}/x.png`,
    `${owner}/${owner}.png/../../x.png`,
    `${owner}/not-a-uuid.png`,
    `${owner}/${owner}.php`,
    `${owner}/${owner}.png\u0000.txt`,
    `/${owner}/${owner}.png`,
    `C:\\${owner}\\${owner}.png`,
    '',
    owner,
  ])('rejects the key %j before touching the disk', async (key) => {
    expect(() => assertStorageKey(key)).toThrow(InvalidStorageKeyError);
    await expect(storage.get(key)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.put(key, PNG)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.delete(key)).rejects.toBeInstanceOf(InvalidStorageKeyError);
  });

  it('writes nothing outside its folder', async () => {
    const before = fs.readdirSync(dir);
    await storage.put(newStorageKey(owner, 'gif'), GIF);
    expect(fs.readdirSync(dir)).toEqual(before);
  });
});

describe('asset routes', () => {
  let h: HostedHarness;
  let a: TestUser;
  let b: TestUser;
  let dir: string;
  let storage: StorageAdapter;

  const upload = (user: TestUser | null, bytes: Uint8Array, name = 'shot.png', fields: Record<string, string> = {}) => {
    const form = new FormData();
    form.set('file', new File([bytes as BlobPart], name, { type: 'image/png' }));
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return handleAssetUpload(
      new Request(`${HOSTED_URL}/api/assets`, {
        method: 'POST',
        headers: { host: new URL(HOSTED_URL).host, origin: HOSTED_URL, ...(user ? { cookie: user.cookie } : {}) },
        body: form,
      }),
      { storage },
    );
  };
  const fetchAsset = (user: TestUser | null, id: string) =>
    handleAssetGet(h.request(user, 'GET', `/api/assets/${id}`), id, { storage });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  beforeAll(async () => {
    h = await hostedHarness();
    a = await h.signUp('assets.a@example.test', 'A');
    b = await h.signUp('assets.b@example.test', 'B');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cph assets '));
    storage = createFilesystemStorage(dir);
  });
  afterAll(async () => {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses signed-out uploads and reads', async () => {
    expect((await upload(null, PNG)).status).toBe(401);
    expect((await fetchAsset(null, '11111111-1111-4111-8111-111111111111')).status).toBe(401);
  });

  it('stores an image, serves it to its owner with hardened headers and dedupes the same bytes', async () => {
    const res = await upload(a, PNG, 'diagram.png', { alt: 'A diagram' });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.created).toBe(true);
    expect(body.asset).toMatchObject({ filename: 'diagram.png', mime: 'image/png', size: PNG.length, alt: 'A diagram' });
    expect(body.asset.markdown).toBe(`![A diagram](asset:${body.asset.id})`);

    const served = await fetchAsset(a, body.asset.id);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(served.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(Array.from(new Uint8Array(await served.arrayBuffer()))).toEqual(Array.from(PNG));

    const again = await upload(a, PNG, 'renamed.png');
    expect(again.status).toBe(200);
    const second = await json(again);
    expect(second.created).toBe(false);
    expect(second.asset.id).toBe(body.asset.id);
    expect(fs.readdirSync(path.join(dir, a.userId))).toHaveLength(1);
  });

  it('decides the type from the bytes, not from the name or claimed type', async () => {
    const res = await upload(a, text('<html><script>alert(1)</script></html>'), 'cute.png');
    expect(res.status).toBe(400);
    const svgNamedPng = await upload(a, text(SAFE_SVG), 'trick.png');
    const body = await json(svgNamedPng);
    expect(body.asset.mime).toBe('image/svg+xml');
  });

  it('serves SVG as a download with a restrictive policy', async () => {
    const created = await json(await upload(a, text(SAFE_SVG.replace('10 10', '10 11')), 'logo.svg'));
    const res = await fetchAsset(a, created.asset.id);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('rejects an unsafe SVG and an oversized upload with clear statuses', async () => {
    const unsafe = await upload(a, text('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), 'bad.svg');
    expect(unsafe.status).toBe(400);
    expect((await json(unsafe)).error).toMatch(/script/);
    const big = new Uint8Array(MAX_ASSET_BYTES + 1);
    big.set(PNG);
    const tooBig = await upload(a, big);
    expect(tooBig.status).toBe(413);
  });

  it('user B can neither fetch nor reuse user A files, even knowing the id', async () => {
    const created = await json(await upload(a, PNG_2, 'private.png'));
    const id = created.asset.id as string;
    expect((await fetchAsset(b, id)).status).toBe(404);
    expect((await assetGet(h.request(b, 'GET', `/api/assets/${id}`), { params: Promise.resolve({ id }) })).status).toBe(404);
    expect((await fetchAsset(b, 'not-a-uuid')).status).toBe(404);

    const bData = forOwner(b.userId, h.ctx.db);
    expect(await bData.assets.get(id)).toBeNull();
    expect(await bData.assets.list()).toEqual([]);

    // The same bytes uploaded by B become B's own file with its own id and key, not a link to A's.
    const theirs = await json(await upload(b, PNG_2, 'mine.png'));
    expect(theirs.created).toBe(true);
    expect(theirs.asset.id).not.toBe(id);
    expect(fs.readdirSync(path.join(dir, b.userId))).toHaveLength(1);
  });

  it('refuses to attach an upload to another owner article', async () => {
    const aArticle = await forOwner(a.userId, h.ctx.db).articles.create({ title: 'Mine', slug: 'mine' });
    const res = await upload(b, new Uint8Array([...PNG, 77]), 'x.png', { articleId: aArticle.id });
    expect(res.status).toBe(404);
    expect(fs.existsSync(path.join(dir, b.userId)) ? fs.readdirSync(path.join(dir, b.userId)).length : 0).toBe(1);
    const ok = await upload(a, new Uint8Array([...PNG, 78]), 'y.png', { articleId: aArticle.id });
    expect(ok.status).toBe(201);
  });
});

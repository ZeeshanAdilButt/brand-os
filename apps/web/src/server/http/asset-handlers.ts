import { MAX_ASSET_BYTES } from '../assets/inspect';
import { listAssets, readAsset, uploadAsset } from '../actions/assets';
import { ActionError } from '../actions/owner';
import { json, withOwner, type HandlerDeps } from './handlers';
import { getStorage } from '../storage';

/** Multipart overhead allowed on top of the file itself. */
const MULTIPART_SLACK = 64 * 1024;

/**
 * Served with the strictest headers that still let an <img> show it: the type was decided from the
 * file's bytes at upload; nosniff stops a browser second-guessing it; the policy forbids scripts,
 * frames and every outgoing request, which matters for SVG opened directly. SVG is also sent as a
 * download so it is never rendered as a document of this origin.
 */
const ASSET_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'private, max-age=3600',
} as const;

function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function handleAssetGet(request: Request, id: string, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    const { asset, bytes } = await readAsset(owner, deps.storage ?? getStorage(ctx.config), id);
    const isSvg = asset.mime === 'image/svg+xml';
    return new Response(bytes as BodyInit, {
      status: 200,
      headers: {
        ...ASSET_HEADERS,
        'Content-Type': asset.mime,
        'Content-Length': String(bytes.length),
        'Content-Disposition': contentDisposition(isSvg ? 'attachment' : 'inline', asset.filename),
        ETag: `"${asset.sha256}"`,
      },
    });
  });
}

export function handleAssetUpload(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES + MULTIPART_SLACK) {
      throw new ActionError('too_large', 'The file is larger than 10 MB.');
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ActionError('invalid', 'Send the image as multipart form data in a field named "file".');
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw new ActionError('invalid', 'Send the image as multipart form data in a field named "file".');
    if (file.size > MAX_ASSET_BYTES) throw new ActionError('too_large', 'The file is larger than 10 MB.');
    const articleId = form.get('articleId');
    const alt = form.get('alt');
    const result = await uploadAsset(
      owner,
      deps.storage ?? getStorage(ctx.config),
      { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name },
      {
        articleId: typeof articleId === 'string' && articleId !== '' ? articleId : null,
        alt: typeof alt === 'string' ? alt : '',
      },
    );
    return json(result, result.created ? 201 : 200);
  });
}

export function handleAssetsList(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    const articleId = new URL(request.url).searchParams.get('articleId');
    return json({ assets: await listAssets(owner, articleId ?? undefined) });
  });
}

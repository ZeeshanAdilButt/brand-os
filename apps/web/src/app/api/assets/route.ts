import { handleAssetsList, handleAssetUpload } from '@/server/http/asset-handlers';

export const dynamic = 'force-dynamic';

/** List the signed-in user's uploaded files (optionally for one article). */
export function GET(request: Request) {
  return handleAssetsList(request);
}

/** Upload one image as multipart form data: field "file", optional "articleId" and "alt". */
export function POST(request: Request) {
  return handleAssetUpload(request);
}

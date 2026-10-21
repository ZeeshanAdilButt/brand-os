import { handleAssetGet } from '@/server/http/asset-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Serve one uploaded file, only to the user who owns it. */
export async function GET(request: Request, { params }: Params) {
  return handleAssetGet(request, (await params).id);
}

import { handleDraftPreview } from '@/server/http/publishing-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return handleDraftPreview(request, (await params).id);
}

import { handleDraftEdit, handleDraftGet } from '@/server/http/publishing-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return handleDraftGet(request, (await params).id);
}

export async function PATCH(request: Request, { params }: Params) {
  return handleDraftEdit(request, (await params).id);
}

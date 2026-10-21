import { handleConnectionPatch, handleConnectionDelete } from '@/server/http/publishing-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return handleConnectionPatch(request, (await params).id);
}

export async function DELETE(request: Request, { params }: Params) {
  return handleConnectionDelete(request, (await params).id);
}

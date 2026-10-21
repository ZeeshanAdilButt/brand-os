import { handleProviderDelete, handleProviderPatch } from '@/server/http/ai-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return handleProviderPatch(request, (await params).id);
}

export async function DELETE(request: Request, { params }: Params) {
  return handleProviderDelete(request, (await params).id);
}

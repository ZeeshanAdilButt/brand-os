import { handleItemDelete, handleItemGet, handleItemPatch } from '@/server/http/handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return handleItemGet(request, (await params).id);
}

export async function PATCH(request: Request, { params }: Params) {
  return handleItemPatch(request, (await params).id);
}

export async function DELETE(request: Request, { params }: Params) {
  return handleItemDelete(request, (await params).id);
}

import { handleSourceDelete } from '@/server/http/handlers';

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleSourceDelete(request, (await params).id);
}

import { handleVersionGet } from '@/server/http/article-handlers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string; no: string }> }) {
  const { id, no } = await params;
  return handleVersionGet(request, id, no);
}

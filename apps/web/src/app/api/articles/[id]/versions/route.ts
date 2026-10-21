import { handleVersionsGet } from '@/server/http/article-handlers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleVersionsGet(request, (await params).id);
}

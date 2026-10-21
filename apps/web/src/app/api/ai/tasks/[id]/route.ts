import { handleTaskGet } from '@/server/http/ai-handlers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleTaskGet(request, (await params).id);
}

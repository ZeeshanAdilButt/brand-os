import { handleTaskRetry } from '@/server/http/ai-handlers';

export const dynamic = 'force-dynamic';

/** Run a failed task again with the same request. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleTaskRetry(request, (await params).id);
}

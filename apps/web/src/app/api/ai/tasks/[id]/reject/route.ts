import { handleTaskReject } from '@/server/http/ai-handlers';

export const dynamic = 'force-dynamic';

/** Reject a waiting result, or cancel a task that has not finished. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleTaskReject(request, (await params).id);
}

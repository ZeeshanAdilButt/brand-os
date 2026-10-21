import { handleTaskAccept } from '@/server/http/ai-handlers';

export const dynamic = 'force-dynamic';

/** Apply a waiting result, as a new version with the reason ai_accept. Nothing is applied any other way. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleTaskAccept(request, (await params).id);
}

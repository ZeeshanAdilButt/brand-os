import { handleAgentTaskGet } from '@/server/http/agent-handlers';

export const dynamic = 'force-dynamic';

/** One task: the text, the instruction and what may be returned. Scope: read. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleAgentTaskGet(request, (await params).id);
}

import { handleAgentDraftStatus } from '@/server/http/agent-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return handleAgentDraftStatus(request, (await params).id);
}

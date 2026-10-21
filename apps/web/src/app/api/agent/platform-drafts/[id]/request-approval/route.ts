import { handleAgentDraftRequestApproval } from '@/server/http/agent-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  return handleAgentDraftRequestApproval(request, (await params).id);
}

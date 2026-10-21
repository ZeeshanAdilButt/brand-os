import { handleAgentDraftGet, handleAgentDraftUpdate } from '@/server/http/agent-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return handleAgentDraftGet(request, (await params).id);
}

export async function PATCH(request: Request, { params }: Params) {
  return handleAgentDraftUpdate(request, (await params).id);
}

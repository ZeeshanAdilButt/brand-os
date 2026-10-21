import { handleAgentDraftStage } from '@/server/http/agent-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  return handleAgentDraftStage(request, (await params).id);
}

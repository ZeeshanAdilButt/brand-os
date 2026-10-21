import { handleAgentDraftsGet, handleAgentDraftCreate } from '@/server/http/agent-handlers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleAgentDraftsGet(request);
}

export async function POST(request: Request) {
  return handleAgentDraftCreate(request);
}

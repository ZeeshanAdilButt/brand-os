import { handleAgentTaskResult } from '@/server/http/agent-handlers';

export const dynamic = 'force-dynamic';

/** Submit { operations } for a pending or running task. Validated like a model's answer; waits for the owner. Scope: ai_tasks. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleAgentTaskResult(request, (await params).id);
}

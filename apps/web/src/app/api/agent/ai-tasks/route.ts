import { handleAgentTasksGet } from '@/server/http/agent-handlers';

export const dynamic = 'force-dynamic';

/** AI tasks of the key owner, pending and running by default (?status=needs_review,accepted for others). Scope: read. */
export function GET(request: Request) {
  return handleAgentTasksGet(request);
}

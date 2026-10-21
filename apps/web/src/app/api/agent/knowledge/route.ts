import { handleAgentKnowledge } from '@/server/http/agent-handlers';

export const dynamic = 'force-dynamic';

/** Search the key owner's knowledge (?q=) or list the latest items. Scope: read. */
export function GET(request: Request) {
  return handleAgentKnowledge(request);
}

import { handleAgentMe } from '@/server/http/agent-handlers';

export const dynamic = 'force-dynamic';

/** Bearer auth. Returns the profile and brand preferences of the credential's owner. */
export function GET(request: Request) {
  return handleAgentMe(request);
}

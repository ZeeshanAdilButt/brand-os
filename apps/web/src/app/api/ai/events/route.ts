import { handleEvents } from '@/server/http/ai-handlers';

export const dynamic = 'force-dynamic';

/** Server-sent events for the signed-in user's AI tasks. */
export function GET(request: Request) {
  return handleEvents(request);
}

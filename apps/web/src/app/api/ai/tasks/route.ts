import { handleTaskCreate, handleTasksGet } from '@/server/http/ai-handlers';

export const dynamic = 'force-dynamic';

/** The signed-in user's AI tasks. Filters: articleId, status (comma separated). */
export function GET(request: Request) {
  return handleTasksGet(request);
}

/** Start a task. It is queued, and runs in the background when the provider runs tasks itself. */
export function POST(request: Request) {
  return handleTaskCreate(request);
}

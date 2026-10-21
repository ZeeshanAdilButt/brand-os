import { handleContextPreview } from '@/server/http/ai-handlers';

export const dynamic = 'force-dynamic';

/** The exact text a task would send to its provider, and which private items were left out. Creates nothing. */
export function POST(request: Request) {
  return handleContextPreview(request);
}

import { handleExport } from '@/server/http/handlers';

export const dynamic = 'force-dynamic';

/** The signed-in user's own data as JSON: profile, preferences, sources and knowledge items. */
export function GET(request: Request) {
  return handleExport(request);
}

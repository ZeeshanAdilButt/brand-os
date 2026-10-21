import { handleDraftsGet, handleDraftCreate } from '@/server/http/publishing-handlers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleDraftsGet(request);
}

export async function POST(request: Request) {
  return handleDraftCreate(request);
}

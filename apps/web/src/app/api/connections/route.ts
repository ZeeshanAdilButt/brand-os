import { handleConnectionsGet, handleConnectionCreate } from '@/server/http/publishing-handlers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleConnectionsGet(request);
}

export async function POST(request: Request) {
  return handleConnectionCreate(request);
}

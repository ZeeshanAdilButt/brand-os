import { handleSourceCreate, handleSourcesGet } from '@/server/http/handlers';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return handleSourcesGet(request);
}

export function POST(request: Request) {
  return handleSourceCreate(request);
}

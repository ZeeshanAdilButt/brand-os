import { handleIntegrationsGet } from '@/server/http/publishing-handlers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleIntegrationsGet(request);
}

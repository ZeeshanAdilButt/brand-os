import { handleConnectorsGet } from '@/server/http/connect-handlers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleConnectorsGet(request);
}

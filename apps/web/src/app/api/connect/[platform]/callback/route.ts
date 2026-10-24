import { handleConnectCallback } from '@/server/http/connect-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ platform: string }> };

export async function GET(request: Request, { params }: Params) {
  return handleConnectCallback(request, (await params).platform);
}

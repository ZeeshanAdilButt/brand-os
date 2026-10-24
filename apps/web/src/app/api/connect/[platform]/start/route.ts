import { handleConnectStart } from '@/server/http/connect-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ platform: string }> };

export async function POST(request: Request, { params }: Params) {
  return handleConnectStart(request, (await params).platform);
}

import { handleConnectDevicePoll } from '@/server/http/connect-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ platform: string }> };

export async function POST(request: Request, { params }: Params) {
  return handleConnectDevicePoll(request, (await params).platform);
}

import { handleConnectDisconnect } from '@/server/http/connect-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ platform: string }> };

export async function DELETE(request: Request, { params }: Params) {
  return handleConnectDisconnect(request, (await params).platform);
}

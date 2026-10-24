import { handleConnectDeviceCancel, handleConnectDeviceStart } from '@/server/http/connect-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ platform: string }> };

export async function POST(request: Request, { params }: Params) {
  return handleConnectDeviceStart(request, (await params).platform);
}

export async function DELETE(request: Request, { params }: Params) {
  return handleConnectDeviceCancel(request, (await params).platform);
}

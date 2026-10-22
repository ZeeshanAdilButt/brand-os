import { handleIntegrationRemove } from '@/server/http/publishing-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ platform: string; kind: string }> };

export async function DELETE(request: Request, { params }: Params) {
  const { platform, kind } = await params;
  return handleIntegrationRemove(request, platform, kind);
}

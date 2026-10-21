import { handleDestinationRemove } from '@/server/http/publishing-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; platform: string }> };

export async function DELETE(request: Request, { params }: Params) {
  const { id, platform } = await params;
  return handleDestinationRemove(request, id, platform);
}

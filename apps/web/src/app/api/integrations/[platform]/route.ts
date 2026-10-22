import { handleIntegrationSave } from '@/server/http/publishing-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ platform: string }> };

export async function PUT(request: Request, { params }: Params) {
  return handleIntegrationSave(request, (await params).platform);
}

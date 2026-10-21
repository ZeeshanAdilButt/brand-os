import { handleDestinationAdd, handleDestinationsGet, handleDestinationsReorder } from '@/server/http/publishing-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return handleDestinationsGet(request, (await params).id);
}

export async function POST(request: Request, { params }: Params) {
  return handleDestinationAdd(request, (await params).id);
}

export async function PATCH(request: Request, { params }: Params) {
  return handleDestinationsReorder(request, (await params).id);
}

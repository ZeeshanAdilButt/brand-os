import { handleApprovalRecord } from '@/server/http/publishing-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  return handleApprovalRecord(request, (await params).id);
}

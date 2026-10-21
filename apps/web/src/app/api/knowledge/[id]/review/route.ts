import { handleItemReview } from '@/server/http/handlers';

export const dynamic = 'force-dynamic';

/** Mark an item reviewed: the owner confirms the claim. This does not make it public. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleItemReview(request, (await params).id);
}

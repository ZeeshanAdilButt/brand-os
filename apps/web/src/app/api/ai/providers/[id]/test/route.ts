import { handleProviderTest } from '@/server/http/ai-handlers';

export const dynamic = 'force-dynamic';

/** Send one tiny harmless prompt to the provider and report the result. No article text is sent. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleProviderTest(request, (await params).id);
}

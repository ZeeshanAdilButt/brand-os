import { handleProviderDefault } from '@/server/http/ai-handlers';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleProviderDefault(request, (await params).id);
}

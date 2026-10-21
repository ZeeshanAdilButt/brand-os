import { handleVersionRestore } from '@/server/http/article-handlers';

export const dynamic = 'force-dynamic';

/** Restore an earlier version as a new one. The body must name `expectedRevision`. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; no: string }> }) {
  const { id, no } = await params;
  return handleVersionRestore(request, id, no);
}

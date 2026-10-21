import { handleAgentArticleGet, handleAgentArticlePatch } from '@/server/http/agent-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** One article with its Markdown body and current revision. Scope: read. */
export async function GET(request: Request, { params }: Params) {
  return handleAgentArticleGet(request, (await params).id);
}

/** Save changes; the body names `expectedRevision`. Creates a version. Scope: write_articles. */
export async function PATCH(request: Request, { params }: Params) {
  return handleAgentArticlePatch(request, (await params).id);
}

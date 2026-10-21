import { handleArticleDelete, handleArticleGet, handleArticlePatch } from '@/server/http/article-handlers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return handleArticleGet(request, (await params).id);
}

/** Save changes. The body must name `expectedRevision`; a stale one is answered with 409 and the current copy. */
export async function PATCH(request: Request, { params }: Params) {
  return handleArticlePatch(request, (await params).id);
}

export async function DELETE(request: Request, { params }: Params) {
  return handleArticleDelete(request, (await params).id);
}

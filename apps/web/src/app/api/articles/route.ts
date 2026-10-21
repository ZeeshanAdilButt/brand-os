import { handleArticleCreate, handleArticlesGet } from '@/server/http/article-handlers';

export const dynamic = 'force-dynamic';

/** List the signed-in user's articles, or search them with ?q=. Filters: status (draft, ready, archived, all). */
export function GET(request: Request) {
  return handleArticlesGet(request);
}

/** Create an article. Every field is optional; the slug is chosen to be free. */
export function POST(request: Request) {
  return handleArticleCreate(request);
}

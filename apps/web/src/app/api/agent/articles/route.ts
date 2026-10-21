import { handleAgentArticleCreate, handleAgentArticlesGet } from '@/server/http/agent-handlers';

export const dynamic = 'force-dynamic';

/** List or search (?q=) the key owner's articles. Scope: read. */
export function GET(request: Request) {
  return handleAgentArticlesGet(request);
}

/** Create an article. Scope: write_articles. */
export function POST(request: Request) {
  return handleAgentArticleCreate(request);
}

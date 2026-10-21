import { handleSlugCheck } from '@/server/http/article-handlers';

export const dynamic = 'force-dynamic';

/** ?slug= and optionally ?exclude=<article id>. Answers whether the slug is free for the signed-in user. */
export function GET(request: Request) {
  return handleSlugCheck(request);
}

import { handleImportUrl } from '@/server/http/import-handlers';

export const dynamic = 'force-dynamic';

/** Import a public web page: { url }. The fetch is SSRF-checked on every hop (see src/server/import/url.ts). */
export function POST(request: Request) {
  return handleImportUrl(request);
}

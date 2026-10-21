import { handleImportFile } from '@/server/http/import-handlers';

export const dynamic = 'force-dynamic';

/** Import a .md, .mdx, .markdown or .txt file (multipart field "file"). Creates a draft with an "import" version. */
export function POST(request: Request) {
  return handleImportFile(request);
}

import { handleFolderGet, handleFolderImport, handleFolderSet } from '@/server/http/import-handlers';

export const dynamic = 'force-dynamic';

/** The configured content folder and its Markdown files (local mode only). */
export function GET(request: Request) {
  return handleFolderGet(request);
}

/** Set the content folder: { path }. An empty path clears it. */
export function PUT(request: Request) {
  return handleFolderSet(request);
}

/** Import one file from the folder: { path } as listed. */
export function POST(request: Request) {
  return handleFolderImport(request);
}

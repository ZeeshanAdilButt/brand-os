import { handleItemCreate, handleItemsGet } from '@/server/http/handlers';

export const dynamic = 'force-dynamic';

/** List the signed-in user's items, or search them with ?q=. Filters: kind, confidentiality, status. */
export function GET(request: Request) {
  return handleItemsGet(request);
}

export function POST(request: Request) {
  return handleItemCreate(request);
}

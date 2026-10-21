import { handleProfileGet, handleProfilePut } from '@/server/http/handlers';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return handleProfileGet(request);
}

export function PUT(request: Request) {
  return handleProfilePut(request);
}

import { handleCredentialRevoke } from '@/server/http/credential-handlers';

export const dynamic = 'force-dynamic';

/** Revoke at once. Revoking twice is fine. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleCredentialRevoke(request, (await params).id);
}

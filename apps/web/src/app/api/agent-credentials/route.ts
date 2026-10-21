import { handleCredentialCreate, handleCredentialsGet } from '@/server/http/credential-handlers';

export const dynamic = 'force-dynamic';

/** The signed-in user's agent credentials. Never includes a secret or its hash. */
export function GET(request: Request) {
  return handleCredentialsGet(request);
}

/** Create a credential: { name, scopes }. The secret is returned once, in this response only. */
export function POST(request: Request) {
  return handleCredentialCreate(request);
}

import { handleProviderCreate, handleProvidersGet } from '@/server/http/ai-handlers';

export const dynamic = 'force-dynamic';

/** The signed-in user's AI providers (never including a key) and whether any is ready. */
export function GET(request: Request) {
  return handleProvidersGet(request);
}

/** Add a provider. A key in the body is encrypted before it is stored and is not returned. */
export function POST(request: Request) {
  return handleProviderCreate(request);
}

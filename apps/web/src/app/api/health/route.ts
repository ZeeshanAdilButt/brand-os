import { NextResponse } from 'next/server';
import { getHealth } from '@/server/actions/system';

// Always evaluate at request time; never prerender a database probe at build.
export const dynamic = 'force-dynamic';

export async function GET() {
  const health = await getHealth();
  return NextResponse.json(health, {
    status: health.status === 'error' ? 503 : 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}

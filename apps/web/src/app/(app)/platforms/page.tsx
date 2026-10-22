import type { Metadata } from 'next';
import { PlatformDirectory, type DirectoryItem } from '@/components/platforms/platform-directory';
import { AREAS, DIRECTORY, directoryStatus, type Area } from '@/lib/directory';
import { sessionToOwner } from '@/server/actions/owner';
import { listConnections } from '@/server/actions/publishing';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Platforms' };
export const dynamic = 'force-dynamic';

export default async function PlatformsPage({ searchParams }: { searchParams: Promise<{ area?: string }> }) {
  const user = await requireSessionUser();
  const connections = await listConnections(sessionToOwner(user, user.ctx));
  const { area } = await searchParams;
  const items: DirectoryItem[] = DIRECTORY.map((entry) => {
    const connection = connections.find((c) => c.platform === entry.id)?.connection ?? null;
    const connected = connection?.status === 'connected';
    return { entry, status: directoryStatus(entry, connected), who: connected ? connection!.who : null };
  });
  const initialArea = (AREAS as readonly string[]).includes(area ?? '') ? (area as Area) : null;
  return <PlatformDirectory items={items} initialArea={initialArea} />;
}

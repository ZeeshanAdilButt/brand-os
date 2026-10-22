import type { ReactNode } from 'react';
import { PageHeader } from '@/components/page-header';
import { PlatformTabs } from '@/components/platforms/platform-tabs';

/** Platforms: the directory of everything you can share to, and the setup for each. */
export default function PlatformsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader title="Platforms" description="Every place your writing can go, what the app can do for each today, and how to connect your accounts." />
      <PlatformTabs />
      {children}
    </>
  );
}

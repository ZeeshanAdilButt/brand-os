import Link from 'next/link';
import { BrandLockup } from '@/components/brand/brand-mark';

/** Product mark and wordmark. Links home. `onForest` is for the forest sidebar. */
export function Brand({ onNavigate, onForest = false, size = 32 }: { onNavigate?: () => void; onForest?: boolean; size?: number }) {
  return (
    <Link href="/" onClick={onNavigate} className="group inline-flex rounded-lg" aria-label="Brand OS home">
      <BrandLockup onForest={onForest} size={size} />
    </Link>
  );
}

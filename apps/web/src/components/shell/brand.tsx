import Link from 'next/link';

/** Product mark and wordmark. Links home. */
export function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link href="/" onClick={onNavigate} className="group flex items-center gap-2.5 rounded-md" aria-label="Brand OS home">
      <span
        aria-hidden
        className="grid size-8 place-items-center rounded-lg bg-primary text-base font-bold leading-none text-primary-foreground"
      >
        B
      </span>
      <span className="text-[1.0625rem] leading-tight font-semibold tracking-tight">Brand OS</span>
    </Link>
  );
}

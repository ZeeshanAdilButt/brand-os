import Link from 'next/link';

/** Product mark and wordmark. Links home. */
export function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link href="/" onClick={onNavigate} className="group flex items-center gap-2.5 rounded-md" aria-label="Brand OS home">
      <span
        aria-hidden
        className="grid size-8 place-items-center rounded-lg bg-primary  text-lg font-semibold leading-none text-primary-foreground shadow-soft"
      >
        B
      </span>
      <span className="flex flex-col leading-tight">
        <span className=" text-[1.0625rem] font-semibold tracking-tight">Brand OS</span>
        <span className="label-caps text-[0.625rem] text-muted-foreground">Engineering</span>
      </span>
    </Link>
  );
}

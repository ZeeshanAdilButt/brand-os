import { AlertCircle, CalendarClock, CheckCircle2, CircleDashed, ExternalLink, Eye, FileText, HelpCircle, Loader2, Lock, Plug, PlugZap, RefreshCw, ScanEye, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { TONE_CLASS, type Chip, type ChipIcon } from '@/lib/chips';
import { cn } from '@/lib/utils';

const ICONS: Record<ChipIcon, LucideIcon> = {
  'dashed-circle': CircleDashed,
  file: FileText,
  lock: Lock,
  review: ScanEye,
  'shield-check': ShieldCheck,
  spinner: Loader2,
  'check-circle': CheckCircle2,
  'alert-circle': AlertCircle,
  'help-circle': HelpCircle,
  refresh: RefreshCw,
  plug: Plug,
  'plug-check': PlugZap,
  eye: Eye,
  'external-link': ExternalLink,
  calendar: CalendarClock,
};

/** The one status pill: text, an icon and a tone from the shared language. Never colour alone. */
export function StatusChip({ chip, className, title }: { chip: Chip; className?: string; title?: string }) {
  const Icon = ICONS[chip.icon];
  return (
    <span
      title={title}
      className={cn('inline-flex min-h-6 w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs font-semibold leading-4', TONE_CLASS[chip.tone], className)}
    >
      <Icon aria-hidden className={cn('size-3.5 shrink-0', chip.icon === 'spinner' && 'motion-safe:animate-spin')} />
      {chip.label}
    </span>
  );
}

import { CheckCircle2, CircleDashed, Eye, EyeOff, Globe, Lock, ShieldAlert, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  CONFIDENTIALITY_LABELS,
  KIND_LABELS,
  VERIFICATION_LABELS,
  type Confidentiality,
  type ItemKind,
  type VerificationStatus,
} from '@/lib/knowledge';
import { cn } from '@/lib/utils';

const base = 'gap-1 border font-medium';

export function KindBadge({ kind }: { kind: ItemKind }) {
  return (
    <Badge variant="outline" className={cn(base, 'font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground')}>
      {KIND_LABELS[kind]}
    </Badge>
  );
}

export function VerificationBadge({ status }: { status: VerificationStatus }) {
  const style: Record<VerificationStatus, { icon: ReactNode; className: string }> = {
    verified: { icon: <CheckCircle2 aria-hidden />, className: 'border-success/40 bg-success/10 text-success' },
    owner_claim_needs_review: { icon: <ShieldAlert aria-hidden />, className: 'border-warning/50 bg-warning/10 text-warning' },
    unverified: { icon: <CircleDashed aria-hidden />, className: 'border-border bg-muted text-muted-foreground' },
  };
  const s = style[status];
  return (
    <Badge variant="outline" className={cn(base, s.className)}>
      {s.icon}
      {VERIFICATION_LABELS[status]}
    </Badge>
  );
}

export function ConfidentialityBadge({ level }: { level: Confidentiality }) {
  const icon = level === 'private' ? <Lock aria-hidden /> : level === 'internal' ? <Users aria-hidden /> : <Globe aria-hidden />;
  return (
    <Badge variant="outline" className={cn(base, 'border-border bg-card text-foreground')}>
      {icon}
      {CONFIDENTIALITY_LABELS[level]}
    </Badge>
  );
}

export function PublicUseBadge({ permitted }: { permitted: boolean }) {
  return permitted ? (
    <Badge variant="outline" className={cn(base, 'border-success/40 bg-success/10 text-success')}>
      <Eye aria-hidden />
      Public use allowed
    </Badge>
  ) : (
    <Badge variant="outline" className={cn(base, 'border-border bg-muted text-muted-foreground')}>
      <EyeOff aria-hidden />
      Not for public use
    </Badge>
  );
}

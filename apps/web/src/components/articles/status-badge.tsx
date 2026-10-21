import { Archive, CheckCircle2, CircleDashed } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { STATUS_LABELS, type ArticleStatus } from '@/lib/articles';
import { cn } from '@/lib/utils';

const STYLE: Record<ArticleStatus, { icon: typeof Archive; className: string }> = {
  draft: { icon: CircleDashed, className: 'border-border bg-muted text-muted-foreground' },
  ready: { icon: CheckCircle2, className: 'border-success/40 bg-success/10 text-success' },
  archived: { icon: Archive, className: 'border-border bg-card text-muted-foreground' },
};

export function ArticleStatusBadge({ status }: { status: ArticleStatus }) {
  const { icon: Icon, className } = STYLE[status];
  return (
    <Badge variant="outline" className={cn('gap-1 border font-medium', className)}>
      <Icon aria-hidden />
      {STATUS_LABELS[status]}
    </Badge>
  );
}

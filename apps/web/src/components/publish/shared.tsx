'use client';

import { ChevronDown, CircleAlert, ExternalLink, Info, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormNotice, Input } from '@/components/ui/field';
import { formatWhen } from '@/lib/format';
import { statusHint, type AttemptDTO, type LintIssue, type PlatformDraftDTO } from '@/lib/publishing';
import { cn } from '@/lib/utils';
import type { Notice } from './use-publish';

export function NoticeBar({ notice }: { notice: Notice | undefined }) {
  if (!notice) return null;
  if (notice.tone === 'info') {
    return (
      <p role="status" className="flex items-start gap-2 rounded-xl border border-info/25 bg-info-subtle px-4 py-3 text-sm text-info">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>{notice.text}</span>
      </p>
    );
  }
  return <FormNotice tone={notice.tone}>{notice.text}</FormNotice>;
}

export interface LintFix {
  label: string;
  run(): void;
}

/** Pass or fix, in plain words. A problem that blocks approval says "Fix"; a suggestion says "Heads up". One-click fixes where there is one. */
export function LintList({ issues, fixes = {}, empty = 'No problems found.' }: { issues: LintIssue[]; fixes?: Partial<Record<string, LintFix>>; empty?: string }) {
  if (issues.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm font-medium text-success">
        <ShieldCheck aria-hidden className="size-4" />
        {empty}
      </p>
    );
  }
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return (
    <ul className="grid gap-2" aria-label="Checks">
      {sorted.map((issue) => {
        const fix = fixes[issue.code];
        const error = issue.severity === 'error';
        return (
          <li key={issue.code + (issue.items?.[0] ?? '')} className={cn('rounded-xl border px-4 py-3 text-sm', error ? 'border-danger/30 bg-danger-subtle' : 'border-warning/30 bg-warning-subtle')}>
            <p className="flex items-start gap-2">
              {error ? <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" /> : <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />}
              <span className="min-w-0 flex-1">
                <span className={cn('font-semibold', error ? 'text-danger' : 'text-warning')}>{error ? 'Fix: ' : 'Heads up: '}</span>
                {issue.message}
              </span>
              {fix ? (
                <Button type="button" size="xs" variant="outline" className="shrink-0 bg-surface" onClick={fix.run}>
                  {fix.label}
                </Button>
              ) : null}
            </p>
            {issue.items?.length ? (
              <ul className="mt-1.5 grid gap-0.5 pl-6">
                {issue.items.map((item) => (
                  <li key={item} className="font-mono text-xs break-all text-muted-foreground">
                    {item}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The counts the checks pill states: what blocks approval and what is only worth a look. */
export function checkCounts(issues: LintIssue[]): { fix: number; headsUp: number } {
  const fix = issues.filter((i) => i.severity === 'error').length;
  return { fix, headsUp: issues.length - fix };
}

/** "1 to fix", "1 to fix · 2 heads up", "2 heads up": the whole of the checks in one short phrase. */
export function checksSummary(issues: LintIssue[]): string {
  const { fix, headsUp } = checkCounts(issues);
  return [fix > 0 ? `${fix} to fix` : null, headsUp > 0 ? `${headsUp} heads up` : null].filter(Boolean).join(' · ');
}

/**
 * The checks of one preview as a single pill: what is wrong in words, and a chevron that opens the full list in place.
 * It is vermilion-toned only when something blocks approval; a list of notes alone is calm; with nothing to say it is a
 * quiet "Checks passed" and not a control.
 */
export function ChecksPill({ issues, open, onToggle, controlsId, empty = 'Checks passed' }: { issues: LintIssue[]; open: boolean; onToggle(): void; controlsId: string; empty?: string }) {
  const { fix } = checkCounts(issues);
  if (issues.length === 0) {
    return (
      <p className="inline-flex h-10 items-center gap-1.5 rounded-full bg-success-bg px-3.5 text-sm font-medium text-success">
        <ShieldCheck aria-hidden className="size-4" />
        {empty}
      </p>
    );
  }
  const Icon = fix > 0 ? CircleAlert : TriangleAlert;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controlsId}
      onClick={onToggle}
      className={cn(
        'inline-flex h-10 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors duration-[120ms]',
        fix > 0 ? 'bg-danger-bg text-danger hover:bg-danger-bg/70' : 'bg-warning-bg text-warning hover:bg-warning-bg/70',
      )}
    >
      <Icon aria-hidden className="size-4" />
      {checksSummary(issues)}
      <span className="sr-only">. {open ? 'Hide the checks' : 'See the checks'}</span>
      <ChevronDown aria-hidden className={cn('size-3.5 transition-transform duration-[120ms] motion-reduce:transition-none', open && 'rotate-180')} />
    </button>
  );
}

/** The full list under the pill. It stays mounted while closed, so the pill always has something to control. */
export function ChecksDrawer({ issues, fixes, open, id, empty = 'No problems found for this platform.' }: { issues: LintIssue[]; fixes?: Partial<Record<string, LintFix>>; open: boolean; id: string; empty?: string }) {
  return (
    <div id={id} hidden={!open} className="border-b px-3 py-3">
      <LintList issues={issues} {...(fixes ? { fixes } : {})} empty={empty} />
    </div>
  );
}

/** The pill with its list under it, for a place that has no slim bar (the large overlay). */
export function ChecksRow({ issues, fixes, empty, defaultOpen = false }: { issues: LintIssue[]; fixes?: Partial<Record<string, LintFix>>; empty?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="grid gap-2">
      <div>
        <ChecksPill issues={issues} open={open} onToggle={() => setOpen((o) => !o)} controlsId={id} {...(empty ? { empty } : {})} />
      </div>
      {issues.length > 0 ? (
        <div id={id} hidden={!open}>
          <LintList issues={issues} {...(fixes ? { fixes } : {})} />
        </div>
      ) : null}
    </div>
  );
}

const ATTEMPT_LABEL = { stage: 'Private draft', publish: 'Publish', check: 'Check', manual: 'By hand' } as const;

/** Every attempt with its outcome, time and a redacted message. */
export function AttemptList({ attempts }: { attempts: AttemptDTO[] }) {
  if (attempts.length === 0) return <p className="text-sm text-muted-foreground">Nothing has been sent to the platform yet.</p>;
  return (
    <ol className="grid gap-1.5" aria-label="History">
      {attempts.map((a) => (
        <li key={a.id} className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
          <span className={cn('mt-1.5 size-2 rounded-full', a.status === 'succeeded' ? 'bg-success' : a.status === 'started' ? 'bg-info' : a.status === 'unknown' ? 'bg-warning' : 'bg-danger')} aria-hidden />
          <div className="min-w-0">
            <p>
              <span className="font-medium">{ATTEMPT_LABEL[a.kind]}</span> <span className="text-muted-foreground">{a.status}</span>
              <span className="text-muted-foreground"> · {formatWhen(a.startedAt)}</span>
            </p>
            {a.message ? <p className="text-xs break-words text-muted-foreground">{a.message}</p> : null}
            {a.remoteUrl ? (
              <a href={a.remoteUrl} target="_blank" rel="noreferrer noopener" className="text-xs break-all text-link underline underline-offset-2">
                {a.remoteUrl}
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Where a post is live, shown prominently, with open and copy. */
export function LiveLink({ draft, name }: { draft: PlatformDraftDTO; name: string }) {
  const [copied, setCopied] = useState(false);
  if (draft.status !== 'published') return null;
  const by = draft.publishedVia === 'manual';
  return (
    <div className="rounded-xl border border-success/30 bg-success-subtle p-4 text-sm">
      <p className="font-semibold text-success">{by ? `Posted by hand on ${name}` : draft.platform === 'site' ? 'Pull request opened' : `Published on ${name}`}</p>
      {draft.platform === 'site' && !by ? <p className="mt-0.5 text-foreground">Merge it in GitHub to go live.</p> : null}
      {by ? <p className="mt-0.5 text-foreground">You recorded this link. This app did not publish it.</p> : null}
      {draft.remoteUrl ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <a href={draft.remoteUrl} target="_blank" rel="noreferrer noopener" className="inline-flex min-w-0 items-center gap-1 font-medium break-all text-link underline underline-offset-2">
            {draft.remoteUrl}
            <ExternalLink aria-hidden className="size-3.5 shrink-0" />
          </a>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="bg-surface"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(draft.remoteUrl!);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      ) : (
        <p className="mt-1 text-muted-foreground">The platform did not return a link. Look for it on your {name} profile.</p>
      )}
      {draft.publishedAt ? <p className="mt-1 text-xs text-muted-foreground">{formatWhen(draft.publishedAt)}</p> : null}
    </div>
  );
}

export function useCountdown(expiresAt: string | null): { left: number | null; expired: boolean; text: string } {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setLeft(Math.max(0, Date.parse(expiresAt) - Date.now()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  const expired = left !== null && left <= 0;
  const text = left === null ? 'Expires in 30 minutes.' : expired ? 'This request has expired.' : `Expires in ${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}.`;
  return { left, expired, text };
}

/** A hint line for a status, in the words of that platform. */
export function StatusHint({ draft }: { draft: PlatformDraftDTO }) {
  return <p className="text-sm leading-6 text-muted-foreground">{statusHint(draft.platform, draft.status, draft.publishedVia)}</p>;
}

/** The explicit "I checked it myself" form for an unknown result. Never offers a retry. */
export function UnknownResolver({ draft, busy, onCheck, onMark }: { draft: PlatformDraftDTO; busy: boolean; onCheck(): void; onMark(body: { outcome: 'posted' | 'not_posted'; remoteUrl?: string }): void }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<'posted' | 'not_posted'>('not_posted');
  const [url, setUrl] = useState('');
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="grid gap-3 rounded-xl border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={onCheck}>
          {busy ? 'Checking' : 'Check on platform'}
        </Button>
        <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          Mark by hand
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">“Check on platform” only reads. It is safe. The post is never sent again on its own.</p>
      {open ? (
        <fieldset className="grid gap-2 rounded-lg bg-muted p-3">
          <legend className="sr-only">Mark the result by hand</legend>
          <p className="text-sm font-medium">Look at the platform first, then say what you found</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`mark-${draft.id}`} checked={outcome === 'not_posted'} onChange={() => setOutcome('not_posted')} className="accent-[var(--primary)]" />
            It is not live
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`mark-${draft.id}`} checked={outcome === 'posted'} onChange={() => setOutcome('posted')} className="accent-[var(--primary)]" />
            It is live
          </label>
          {outcome === 'posted' ? <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link to the live post (optional)" aria-label="Link to the live post" inputMode="url" /> : null}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5 size-4 accent-[var(--primary)]" />
            <span>I checked on the platform myself and this is what I saw.</span>
          </label>
          <div>
            <Button type="button" size="sm" disabled={!confirm || busy} onClick={() => onMark({ outcome, ...(outcome === 'posted' && url.trim() ? { remoteUrl: url.trim() } : {}) })}>
              Record this
            </Button>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'info' }) {
  return (
    <Badge variant="outline" className={cn('font-medium', tone === 'info' ? 'border-info/25 bg-info-subtle text-info' : 'border-border bg-neutral-subtle text-neutral')}>
      {children}
    </Badge>
  );
}

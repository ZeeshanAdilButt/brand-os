'use client';

import { ExternalLink, Lock, Send, ShieldCheck, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CopyButton } from '@/components/integrations/parts';
import { Button } from '@/components/ui/button';
import { FormNotice, Input } from '@/components/ui/field';
import { PLATFORMS } from '@/lib/catalog';
import { buildManualKit, validateManualUrl, type ManualContext } from '@/lib/manual';
import { CANONICAL_NOT_LIVE_BOX, type DestinationDTO, type PlatformDraftDTO } from '@/lib/publishing';
import { renderSiteFile } from '@/lib/site-export';
import { cn } from '@/lib/utils';
import { AttemptList, LintList, LiveLink, NoticeBar, StatusHint, UnknownResolver, useCountdown } from './shared';
import type { PublishApi } from './use-publish';

export interface SiteFacts {
  siteHost: string | null;
  repo: string | null;
  baseBranch: string;
}

export type SettledOutcome = 'published' | 'failed' | 'unknown';

/** The exact post, the account, the canonical state and the boxes. The one button approves this payload and no other. */
export function ApprovalCard({
  draft,
  name,
  busy,
  approveLabel,
  onApprove,
  onDecline,
}: {
  draft: PlatformDraftDTO;
  name: string;
  busy: boolean;
  approveLabel: string;
  onApprove(checked: string[]): void;
  onDecline(): void;
}) {
  const approval = draft.approval!;
  const boxes = approval.checklist;
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const all = boxes.every((b) => ticked[b]);
  const { expired, text } = useCountdown(approval.expiresAt);
  const notLive = draft.canonical && draft.canonical.state !== 'live';
  const heading = `approval-${approval.id}`;

  return (
    <section aria-labelledby={heading} className="min-w-0 rounded-xl border-2 border-warning bg-surface p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={heading} className="text-base font-semibold">
          Approve this exact post
        </h4>
        <span className="rounded-md border bg-muted px-2 py-0.5 font-mono text-xs font-semibold" title="Short tag of the payload hash. It changes if anything in the post changes.">
          {approval.tag}
        </span>
      </header>
      <p className="mt-1 text-xs text-muted-foreground">
        {text} Single use.{approval.requestedBy === 'agent' ? ' Requested by your agent.' : ''}
      </p>

      <dl className="mt-3 grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[6.5rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Destination</dt>
        <dd className="font-medium">{name}</dd>
        <dt className="text-muted-foreground">Account</dt>
        <dd className="font-medium">{draft.account ?? 'unknown'}</dd>
        <dt className="text-muted-foreground">Title</dt>
        <dd className="font-medium break-words">{draft.payload.title}</dd>
        <dt className="text-muted-foreground">Canonical</dt>
        <dd className="break-all">{draft.payload.canonicalUrl ?? 'not set'}</dd>
        <dt className="text-muted-foreground">Tags</dt>
        <dd className="font-mono text-xs leading-6">{draft.payload.tags.join(', ') || 'none'}</dd>
      </dl>

      {notLive ? (
        <p role="status" className="mt-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2 text-sm">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            <strong className="font-semibold text-warning">The canonical page is not live.</strong> {draft.canonical!.message} Your own site should go first so this copy points to something. You can still continue after ticking the extra box below.
          </span>
        </p>
      ) : null}

      <details className="mt-3 rounded-lg border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Technical details: the exact request that will be sent</summary>
        <pre tabIndex={0} aria-label="The request body that will be sent" className="max-h-64 overflow-auto border-t bg-code-background px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
          {draft.requestPreview}
        </pre>
      </details>

      <fieldset className="mt-3 grid gap-2" disabled={expired || busy}>
        <legend className="mb-1 text-sm font-medium">Tick every box to approve</legend>
        {boxes.map((box) => (
          <label key={box} className={cn('flex cursor-pointer items-start gap-2.5 text-sm leading-snug', box === CANONICAL_NOT_LIVE_BOX && 'font-medium')}>
            <input type="checkbox" checked={Boolean(ticked[box])} onChange={(e) => setTicked((t) => ({ ...t, [box]: e.target.checked }))} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" />
            <span>{box}</span>
          </label>
        ))}
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" size="lg" disabled={!all || expired || busy} onClick={() => onApprove(boxes.filter((b) => ticked[b]))}>
          <Send aria-hidden />
          {busy ? 'Working' : approveLabel}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onDecline}>
          {expired ? 'Close' : 'Decline'}
        </Button>
      </div>
      {!all ? <p className="mt-2 text-xs text-muted-foreground">The button stays off until every box is ticked. There is no way to approve more than this one post.</p> : null}
    </section>
  );
}

/** Posting by hand: copy what the platform asks for, open its page, then record the link with an approval. Never claims the app published it. */
export function ManualHandoff({ destination, api, facts }: { destination: DestinationDTO; api: PublishApi; facts: SiteFacts }) {
  const draft = destination.draft!;
  const info = PLATFORMS[destination.platform];
  const [url, setUrl] = useState('');
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const approval = draft.approval && draft.approval.kind === 'manual' && draft.approval.status === 'pending' ? draft.approval : null;
  const busy = api.isBusy(destination.platform);

  const ctx: ManualContext = useMemo(() => {
    const site = draft.extras.site;
    return {
      siteHost: facts.siteHost,
      siteRepo: site?.repo ?? facts.repo,
      siteBase: site?.baseBranch ?? facts.baseBranch,
      sitePath: site?.path ?? null,
      siteFile: site ? renderSiteFile(draft.payload, site.mapping, site.dateIso, site.slug).content : null,
    };
  }, [draft.extras.site, draft.payload, facts]);
  const kit = useMemo(() => buildManualKit(destination.platform, draft.payload, draft.extras, ctx), [destination.platform, draft.payload, draft.extras, ctx]);
  const verdict = url.trim() ? validateManualUrl(destination.platform, url, ctx) : null;
  const all = approval ? approval.checklist.every((b) => ticked[b]) : false;
  const { expired, text } = useCountdown(approval?.expiresAt ?? null);

  return (
    <section aria-label={`Post on ${info.name} by hand`} className="grid gap-3 rounded-xl border bg-surface p-4">
      <div>
        <h4 className="text-base font-semibold">Post it yourself: {info.name}</h4>
        <p className="mt-0.5 text-sm leading-6 text-muted-foreground">Copy the parts below and post them yourself. Then record the link here. This app never claims it published the post.</p>
      </div>
      <ol className="grid gap-1 pl-5 text-sm leading-6">
        {kit.steps.map((step) => (
          <li key={step} className="list-decimal">
            {step}
          </li>
        ))}
      </ol>
      <div className="grid gap-2">
        {kit.parts.map((part) => (
          <div key={part.label} className="grid gap-1 rounded-lg border bg-background p-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold">{part.label}</p>
              <CopyButton text={part.value} label="Copy" size="xs" variant="ghost" />
            </div>
            <pre className="max-h-40 overflow-auto font-mono text-xs leading-5 break-words whitespace-pre-wrap">{part.value}</pre>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={kit.all} label="Copy everything" variant="default" />
        <a href={kit.openUrl} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-surface px-3 text-sm font-medium hover:bg-muted">
          {kit.openLabel}
          <ExternalLink aria-hidden className="size-4" />
        </a>
        {kit.submitUrl ? (
          <a href={kit.submitUrl} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-surface px-3 text-sm font-medium hover:bg-muted">
            Open the pre-filled page
            <ExternalLink aria-hidden className="size-4" />
          </a>
        ) : null}
      </div>
      {kit.submitNote ? <p className="text-xs text-muted-foreground">{kit.submitNote}</p> : null}

      {draft.status === 'published' ? null : approval ? (
        <div className="grid gap-3 rounded-lg border-2 border-warning p-3">
          <p className="text-sm font-semibold">Record your post</p>
          <p className="text-xs text-muted-foreground">
            {text} This records a post you made by hand. Nothing is sent to {info.name}. Approval tag {approval.tag}.
          </p>
          <label className="grid gap-1 text-sm font-medium">
            Link to your post
            <Input value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" placeholder={`https://… on ${info.manual.hosts.filter((h) => !h.startsWith('*') && h !== '*')[0] ?? info.name}`} aria-invalid={verdict && !verdict.ok ? true : undefined} />
          </label>
          {verdict && !verdict.ok ? <FormNotice tone="error">{verdict.reason}</FormNotice> : null}
          <fieldset className="grid gap-2" disabled={busy || expired}>
            <legend className="mb-1 text-sm font-medium">Tick every box to record</legend>
            {approval.checklist.map((box) => (
              <label key={box} className="flex cursor-pointer items-start gap-2.5 text-sm leading-snug">
                <input type="checkbox" checked={Boolean(ticked[box])} onChange={(e) => setTicked((t) => ({ ...t, [box]: e.target.checked }))} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" />
                <span>{box}</span>
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={!all || !verdict?.ok || busy || expired} onClick={() => void api.record(destination.platform, approval.id, { checked: approval.checklist.filter((b) => ticked[b]), url })}>
              {busy ? 'Recording' : 'I posted it: record the link'}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void api.decline(destination.platform, approval.id)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" variant="outline" disabled={busy || draft.status === 'publishing' || draft.status === 'unknown' || draft.status === 'source_changed'} onClick={() => void api.ask(destination.platform, draft.id, 'manual')}>
            I posted it
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">Next you enter the link and approve the record. It is checked against {info.name}’s own address.</p>
        </div>
      )}
    </section>
  );
}

/**
 * Review one destination: everything the owner needs to decide, then the one approval. For a platform the app can send
 * to, a private copy is created first (an explicit button; nothing is public), and the approval request is created for
 * you when you arrive at the staged post. For every platform there is also the manual route.
 */
export function ApprovalReview({
  destination,
  api,
  facts,
  approveLabel,
  onSettled,
  onEdit,
}: {
  destination: DestinationDTO;
  api: PublishApi;
  facts: SiteFacts;
  approveLabel?: string;
  onSettled?: (outcome: SettledOutcome) => void;
  onEdit?: () => void;
}) {
  const { platform, info } = destination;
  const draft = destination.draft;
  const publishable = info.state === 'adapter';
  const connected = destination.connection?.status === 'connected';
  const busyAny = api.isBusy(platform);
  const asked = useRef<string | null>(null);

  // Arriving at a staged post creates its approval request, so there is no separate "request approval" step for the owner.
  useEffect(() => {
    if (!draft || !publishable || draft.status !== 'staged') return;
    if (asked.current === draft.payloadSha256) return;
    asked.current = draft.payloadSha256;
    void api.ask(platform, draft.id, 'publish');
    // The hash identifies the post; asking again for the same post would only void the request just made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, draft?.status, draft?.payloadSha256, publishable]);

  if (!draft) {
    return (
      <div className="grid gap-3 rounded-xl border p-4">
        <p className="text-sm">This destination has not been prepared yet. Preparing builds the post from your article and sends nothing.</p>
        <div>
          <Button type="button" onClick={() => void api.prepare(platform)} disabled={busyAny}>
            {api.isBusy(platform, 'prepare') ? 'Preparing' : `Prepare ${info.name}`}
          </Button>
        </div>
      </div>
    );
  }

  const errors = draft.lint.filter((i) => i.severity === 'error');
  const pending = draft.status === 'pending_approval' && draft.approval?.status === 'pending' && draft.approval.kind === 'publish';
  const defaultApprove = platform === 'site' ? 'Approve and open the pull request' : `Approve and publish to ${info.name}`;

  return (
    <div className="grid gap-4">
      <NoticeBar notice={api.notices[platform]} />
      <StatusHint draft={draft} />
      <LiveLink draft={draft} name={info.name} />

      {draft.failureMessage && (draft.status === 'failed' || draft.status === 'unknown') ? (
        <div role="alert" className={cn('rounded-xl border p-3 text-sm', draft.status === 'unknown' ? 'border-warning/40 bg-warning-subtle' : 'border-danger/30 bg-danger-subtle')}>
          <p className="font-semibold">{draft.status === 'unknown' ? 'The result is not known' : 'It did not go out'}</p>
          <p className="mt-1 break-words">{draft.failureMessage}</p>
          {draft.nextAction ? <p className="mt-1 font-medium">{draft.nextAction}</p> : null}
        </div>
      ) : null}

      {draft.status === 'unknown' ? (
        <UnknownResolver draft={draft} busy={api.isBusy(platform, 'check') || api.isBusy(platform, 'mark')} onCheck={() => void api.check(platform, draft.id).then((r) => r.ok && r.data.draft.status === 'published' && onSettled?.('published'))} onMark={(body) => void api.mark(platform, draft.id, body)} />
      ) : null}

      {draft.status === 'source_changed' ? (
        <div className="rounded-xl border border-warning/40 bg-warning-subtle p-3 text-sm">
          <p className="font-semibold">You edited the article after this was built</p>
          <p className="mt-1">Any approval for the old text is void. Rebuild to see exactly what would be sent now.</p>
          <Button type="button" size="sm" className="mt-2" disabled={busyAny} onClick={() => void api.prepare(platform, { discardEdits: true })}>
            Rebuild from the article
          </Button>
        </div>
      ) : null}

      {draft.status !== 'published' && draft.status !== 'source_changed' && draft.status !== 'unknown' && draft.status !== 'publishing' ? (
        <>
          {errors.length > 0 ? (
            <div className="grid gap-2">
              <LintList issues={errors} />
              {onEdit ? (
                <div>
                  <Button type="button" variant="outline" size="sm" onClick={onEdit}>
                    Go back and fix
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {publishable && errors.length === 0 ? (
            !connected ? (
              <div className="rounded-xl border border-warning/30 bg-warning-subtle p-3 text-sm">
                <p className="font-semibold">{info.name} is not connected</p>
                <p className="mt-1">Connect it to stage and publish. You can still post by hand below.</p>
                <Link href={`/platforms/integrations#${platform}`} className="mt-2 inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
                  Connect {info.name}
                </Link>
              </div>
            ) : draft.status === 'draft' || draft.status === 'failed' ? (
              <div className="grid gap-2 rounded-xl border bg-surface p-3">
                <p className="flex items-start gap-2 text-sm leading-6">
                  <Lock aria-hidden className="mt-1 size-4 shrink-0 text-info" />
                  <span>
                    {platform === 'site'
                      ? 'Check the repository first. This only reads it, to see where the file will go and whether one is already there. Nothing is written.'
                      : `Create a private draft on ${info.name}. This uploads a copy of the post to your account there, but it is not public. You can look at it before you approve anything.`}
                  </span>
                </p>
                <div>
                  <Button type="button" onClick={() => void api.stage(platform, draft.id)} disabled={busyAny}>
                    {api.isBusy(platform, 'stage') ? 'Working' : platform === 'site' ? 'Check the repository' : `Create private draft on ${info.name}`}
                  </Button>
                </div>
              </div>
            ) : draft.status === 'staged' ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                <ShieldCheck aria-hidden className="size-4" />
                {api.isBusy(platform, 'ask') ? 'Preparing the approval for this exact post…' : 'Ready. Preparing the approval for this exact post…'}
                {draft.remotePreviewUrl ? (
                  <a href={draft.remotePreviewUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-link underline underline-offset-2">
                    Open the private draft
                    <ExternalLink aria-hidden className="size-3.5" />
                  </a>
                ) : null}
              </p>
            ) : null
          ) : null}

          {pending ? (
            <ApprovalCard
              draft={draft}
              name={info.name}
              busy={api.isBusy(platform, 'approve') || api.isBusy(platform, 'decline')}
              approveLabel={approveLabel ?? defaultApprove}
              onApprove={(checked) =>
                void api.approve(platform, draft.approval!.id, checked).then((result) => {
                  if (result.ok) onSettled?.(result.data.outcome);
                })
              }
              onDecline={() => void api.decline(platform, draft.approval!.id)}
            />
          ) : null}
          {draft.remotePreviewUrl && draft.status !== 'staged' ? (
            <a href={draft.remotePreviewUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-sm font-medium text-link underline underline-offset-2">
              Open the private draft on {info.name}
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          ) : null}
        </>
      ) : null}

      {!publishable && draft.status !== 'published' ? (
        <p className="rounded-xl bg-muted px-3 py-2 text-sm leading-6">
          {info.name} cannot be published to from here yet: {info.reason} Use the steps below.
        </p>
      ) : null}

      {draft.status !== 'publishing' ? <ManualHandoff destination={destination} api={api} facts={facts} /> : null}

      <details className="rounded-lg border bg-surface">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">History ({draft.attempts.length})</summary>
        <div className="border-t p-3">
          <AttemptList attempts={draft.attempts} />
        </div>
      </details>
    </div>
  );
}

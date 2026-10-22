'use client';

import { ArrowUpRight, CircleAlert, ExternalLink, Info, Lock, RefreshCw, Send, ShieldCheck, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormNotice, Input } from '@/components/ui/field';
import { api } from '@/lib/api-client';
import { formatWhen } from '@/lib/format';
import {
  DRAFT_STATUS_HINTS,
  DRAFT_STATUS_LABELS,
  approvalChecklist,
  type AttemptDTO,
  type DestinationDTO,
  type DraftStatus,
  type LintIssue,
  type PlatformDraftDTO,
} from '@/lib/publishing';
import { cn } from '@/lib/utils';

const STATUS_TONE: Record<DraftStatus, string> = {
  draft: 'border-input text-muted-foreground',
  staged: 'border-teal-text/50 text-teal-text',
  pending_approval: 'border-warning/60 text-warning',
  approved: 'border-warning/60 text-warning',
  publishing: 'border-warning/60 text-warning',
  published: 'border-success/60 bg-success/10 text-success',
  failed: 'border-destructive/50 text-destructive',
  unknown: 'border-destructive/60 bg-destructive/10 text-destructive',
  source_changed: 'border-warning/60 text-warning',
};

interface Notice {
  tone: 'error' | 'success';
  text: string;
}

interface Props {
  articleId: string;
  /** Changes whenever a save is confirmed, so drafts flagged by an edit show as such. */
  refreshKey: number;
  /** The editor's unsent changes would not be in a draft built now, so building waits for them. */
  saved: boolean;
}

/** The studio's Publish panel: one card per destination, from preparing a draft to the approved publish. */
export function PublishPanel({ articleId, refreshKey, saved }: Props) {
  const [destinations, setDestinations] = useState<DestinationDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, Notice | undefined>>({});

  const load = useCallback(async () => {
    const result = await api<{ destinations: DestinationDTO[] }>(`/api/articles/${articleId}/destinations`);
    if (result.ok) {
      setDestinations(result.data.destinations);
      setError(null);
    } else setError(result.network ? 'Could not load the destinations while offline.' : result.error);
  }, [articleId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), destinations === null ? 0 : 500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey]);

  // While a publish is in flight (this tab or another), look again every few seconds.
  const publishing = destinations?.some((d) => d.draft?.status === 'publishing') ?? false;
  useEffect(() => {
    if (!publishing) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [publishing, load]);

  const setDraft = (draft: PlatformDraftDTO) =>
    setDestinations((current) => current?.map((d) => (d.platform === draft.platform ? { ...d, draft } : d)) ?? current);
  const setNotice = (platform: string, notice: Notice | undefined) => setNotices((current) => ({ ...current, [platform]: notice }));

  if (error && destinations === null) return <FormNotice tone="error">{error}</FormNotice>;
  if (destinations === null) {
    return (
      <div className="grid gap-3" aria-busy="true" aria-label="Loading destinations">
        {[1, 2].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Nothing leaves this app until you approve that exact post. Preparing and staging only make a private copy on the platform.
      </p>
      {error ? <FormNotice tone="error">{error}</FormNotice> : null}
      {destinations.map((destination) => (
        <DestinationCard
          key={destination.platform}
          articleId={articleId}
          destination={destination}
          saved={saved}
          notice={notices[destination.platform]}
          onNotice={(notice) => setNotice(destination.platform, notice)}
          onDraft={setDraft}
          onReload={() => void load()}
        />
      ))}
    </div>
  );
}

function LintList({ issues }: { issues: LintIssue[] }) {
  if (issues.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-teal-text">
        <ShieldCheck aria-hidden className="size-4" />
        No problems found.
      </p>
    );
  }
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return (
    <ul className="grid gap-2" aria-label="Checks">
      {sorted.map((issue) => (
        <li key={issue.code + (issue.items?.[0] ?? '')} className={cn('rounded-md border px-3 py-2 text-sm', issue.severity === 'error' ? 'border-destructive/40 bg-destructive/10' : 'border-warning/40 bg-warning/10')}>
          <p className="flex items-start gap-2">
            {issue.severity === 'error' ? <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" /> : <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />}
            <span>
              <span className="font-medium">{issue.severity === 'error' ? 'Must fix: ' : 'Heads up: '}</span>
              {issue.message}
            </span>
          </p>
          {issue.items?.length ? (
            <ul className="mt-1.5 grid gap-0.5 pl-6">
              {issue.items.map((item) => (
                <li key={item} className="break-all font-mono text-xs text-muted-foreground">
                  {item}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function PayloadSummary({ draft }: { draft: PlatformDraftDTO }) {
  const { payload } = draft;
  return (
    <div className="grid gap-3 text-sm">
      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Title</dt>
        <dd className="min-w-0 break-words font-medium">{payload.title || <em className="text-destructive">empty</em>}</dd>
        <dt className="text-muted-foreground">Description</dt>
        <dd className="min-w-0 break-words">{payload.description || <span className="text-muted-foreground">none</span>}</dd>
        <dt className="text-muted-foreground">Tags</dt>
        <dd className="flex flex-wrap gap-1">
          {payload.tags.length ? payload.tags.map((t) => <Badge key={t} variant="secondary" className="font-mono">{t}</Badge>) : <span className="text-muted-foreground">none</span>}
        </dd>
        <dt className="text-muted-foreground">Canonical URL</dt>
        <dd className="min-w-0 break-all">{payload.canonicalUrl ?? <span className="text-muted-foreground">not set</span>}</dd>
        <dt className="text-muted-foreground">Cover image</dt>
        <dd className="min-w-0 break-all">{payload.coverImageUrl ?? <span className="text-muted-foreground">none</span>}</dd>
        {payload.series ? (
          <>
            <dt className="text-muted-foreground">Series</dt>
            <dd>{payload.series}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Account</dt>
        <dd>{draft.account ?? 'unknown'}</dd>
      </dl>
      {draft.tagReport.changes.length > 0 ? (
        <div className="rounded-md bg-muted px-3 py-2">
          <p className="text-xs font-medium">Tags were cleaned for this platform</p>
          <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
            {draft.tagReport.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <details className="rounded-md border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">The Markdown that will be sent ({payload.bodyMarkdown.length.toLocaleString('en')} characters)</summary>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t bg-background px-3 py-2 font-mono text-xs leading-relaxed">{payload.bodyMarkdown}</pre>
      </details>
    </div>
  );
}

function AttemptList({ attempts }: { attempts: AttemptDTO[] }) {
  if (attempts.length === 0) return <p className="text-sm text-muted-foreground">Nothing has been sent to the platform yet.</p>;
  const label = { stage: 'Private draft', publish: 'Publish', check: 'Check', manual: 'By hand' } as const;
  return (
    <ol className="grid gap-1.5">
      {attempts.map((a) => (
        <li key={a.id} className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
          <span className={cn('mt-1.5 size-2 rounded-full', a.status === 'succeeded' ? 'bg-success' : a.status === 'started' ? 'bg-warning' : 'bg-destructive')} aria-hidden />
          <div className="min-w-0">
            <p>
              <span className="font-medium">{label[a.kind]}</span> <span className="text-muted-foreground">{a.status}</span>
              <span className="text-muted-foreground"> · {formatWhen(a.startedAt)}</span>
            </p>
            {a.message ? <p className="break-words text-xs text-muted-foreground">{a.message}</p> : null}
            {a.remoteUrl ? (
              <a href={a.remoteUrl} target="_blank" rel="noreferrer noopener" className="break-all text-xs text-link underline underline-offset-2">
                {a.remoteUrl}
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

interface CardProps {
  articleId: string;
  destination: DestinationDTO;
  saved: boolean;
  notice: Notice | undefined;
  onNotice(notice: Notice | undefined): void;
  onDraft(draft: PlatformDraftDTO): void;
  onReload(): void;
}

function DestinationCard({ articleId, destination, saved, notice, onNotice, onDraft, onReload }: CardProps) {
  const { info, connection, draft } = destination;
  const [busy, setBusy] = useState<string | null>(null);
  const [cover, setCover] = useState(draft?.payload.coverImageUrl ?? '');
  const [series, setSeries] = useState(draft?.payload.series ?? '');
  const [showRequest, setShowRequest] = useState(false);
  const idBase = `pub-${info.id}`;

  const connected = connection?.status === 'connected';
  const errors = draft?.lint.filter((i) => i.severity === 'error') ?? [];

  async function run<T>(name: string, call: () => Promise<{ ok: true; data: T } | { ok: false; error: string; network: boolean }>, done: (data: T) => void) {
    setBusy(name);
    onNotice(undefined);
    const result = await call();
    setBusy(null);
    if (result.ok) done(result.data);
    else onNotice({ tone: 'error', text: result.network ? 'Could not reach the app server.' : result.error });
  }

  const prepare = () =>
    run(
      'prepare',
      () => api<PlatformDraftDTO>('/api/platform-drafts', { json: { articleId, platform: info.id, ...(draft || cover.trim() ? { coverImageUrl: cover.trim() || null } : {}), ...(draft || series.trim() ? { series: series.trim() || null } : {}) } }),
      (d) => {
        onDraft(d);
        onNotice({ tone: 'success', text: d.lint.some((i) => i.severity === 'error') ? 'Draft built. Fix the problems below before staging.' : 'Draft built from the saved article. Nothing was sent.' });
      },
    );

  const stage = () =>
    draft &&
    run(
      'stage',
      () => api<{ ok: boolean; message: string; draft: PlatformDraftDTO }>(`/api/platform-drafts/${draft.id}/stage`, { method: 'POST', json: {} }),
      (r) => {
        onDraft(r.draft);
        onNotice({ tone: r.ok ? 'success' : 'error', text: r.message });
      },
    );

  const requestApproval = () =>
    draft &&
    run(
      'request',
      () => api<{ draft: PlatformDraftDTO; link: string }>(`/api/platform-drafts/${draft.id}/request-approval`, { method: 'POST', json: {} }),
      (r) => {
        onDraft(r.draft);
        onNotice({ tone: 'success', text: 'Review the exact post below. It expires in 30 minutes.' });
      },
    );

  const check = () =>
    draft &&
    run(
      'check',
      () => api<{ remote: string; message: string; draft: PlatformDraftDTO }>(`/api/platform-drafts/${draft.id}/check`, { method: 'POST', json: {} }),
      (r) => {
        onDraft(r.draft);
        onNotice({ tone: r.remote === 'published' || r.remote === 'private' ? 'success' : 'error', text: r.message });
      },
    );

  return (
    <section aria-labelledby={`${idBase}-title`} className="min-w-0 rounded-xl border bg-background p-3.5 sm:p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`${idBase}-title`} className=" text-lg font-semibold">
            {info.name}
          </h3>
          <p className="text-xs text-muted-foreground">
            {connection ? (connected ? `Connected${connection.who ? ` as ${connection.who}` : ''}` : `${connection.lastCheckMessage ?? 'Needs reconnecting'}`) : 'Not connected'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {draft ? (
            <Badge variant="outline" className={cn(STATUS_TONE[draft.status])}>
              {DRAFT_STATUS_LABELS[draft.status]}
            </Badge>
          ) : null}
          <Badge variant="outline" className={cn(info.verification.level === 'docs_only' ? 'border-warning/60 text-warning' : 'border-input text-muted-foreground')} title={info.verification.detail}>
            {info.verification.label}
          </Badge>
        </div>
      </header>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">What it can and cannot do</summary>
        <ul className="mt-2 grid gap-1 pl-1 text-xs leading-relaxed text-muted-foreground">
          <li>Private drafts: {info.capabilities.drafts ? 'yes' : 'no'}. Scheduling: not built yet.</li>
          <li>Canonical URL: {info.capabilities.canonicalUrl ? 'yes' : 'no'}. Tags: at most {info.capabilities.tagsMax}. Series: {info.capabilities.series ? 'by name' : 'not sent yet'}.</li>
          <li>{info.capabilities.media}</li>
          {info.capabilities.restrictions.map((r) => (
            <li key={r}>{r}</li>
          ))}
          <li>{info.verification.detail}</li>
        </ul>
      </details>

      {notice ? (
        <div className="mt-3">
          <FormNotice tone={notice.tone}>{notice.text}</FormNotice>
        </div>
      ) : null}

      {!connection ? (
        <div className="mt-4 rounded-lg border border-dashed p-3 text-sm">
          <p className="font-medium">Connect {info.name} first</p>
          <p className="mt-1 text-muted-foreground">Add your key in Settings. Nothing is sent until you approve a post.</p>
          <Link href="/settings/connections" className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-link underline underline-offset-2">
            Open Connections
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      ) : !draft ? (
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-3">
          {!connected ? (
            <FormNotice tone="error">
              {info.name} needs reconnecting before you can publish. <Link href="/settings/connections" className="font-medium underline">Open Connections</Link>
            </FormNotice>
          ) : null}
          <Optional info={info} idBase={idBase} cover={cover} series={series} setCover={setCover} setSeries={setSeries} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={!saved || busy !== null} onClick={() => void prepare()}>
              {busy === 'prepare' ? 'Building' : 'Prepare draft'}
            </Button>
            {!saved ? <span className="text-xs text-muted-foreground">Saving your latest changes first.</span> : <span className="text-xs text-muted-foreground">Builds the post from the saved article. Sends nothing.</span>}
          </div>
        </div>
      ) : (
        <DraftBody
          draft={draft}
          info={info}
          connected={connected}
          errors={errors.length}
          saved={saved}
          busy={busy}
          cover={cover}
          series={series}
          setCover={setCover}
          setSeries={setSeries}
          showRequest={showRequest}
          setShowRequest={setShowRequest}
          onPrepare={() => void prepare()}
          onStage={() => void stage()}
          onRequest={() => void requestApproval()}
          onCheck={() => void check()}
          onDraft={onDraft}
          onNotice={onNotice}
          onReload={onReload}
        />
      )}
    </section>
  );
}

function Optional({ info, idBase, cover, series, setCover, setSeries }: { info: DestinationDTO['info']; idBase: string; cover: string; series: string; setCover(v: string): void; setSeries(v: string): void }) {
  return (
    <details className="rounded-md border px-3 py-1">
      <summary className="cursor-pointer py-1.5 text-sm font-medium">Cover image{info.capabilities.series ? ' and series' : ''} (optional)</summary>
      <div className="grid gap-3 pb-3 pt-1">
        <div className="grid gap-1">
          <label htmlFor={`${idBase}-cover`} className="text-xs font-medium">
            Cover image URL
          </label>
          <Input id={`${idBase}-cover`} value={cover} onChange={(e) => setCover(e.target.value)} placeholder="https://example-blog.dev/img/cover.png" inputMode="url" className="h-9" />
          <p className="text-xs text-muted-foreground">Must be a public https address. Images stored in this app cannot be sent.</p>
        </div>
        {info.capabilities.series ? (
          <div className="grid gap-1">
            <label htmlFor={`${idBase}-series`} className="text-xs font-medium">
              Series name
            </label>
            <Input id={`${idBase}-series`} value={series} onChange={(e) => setSeries(e.target.value)} maxLength={100} className="h-9" />
          </div>
        ) : null}
      </div>
    </details>
  );
}

interface BodyProps {
  draft: PlatformDraftDTO;
  info: DestinationDTO['info'];
  connected: boolean;
  errors: number;
  saved: boolean;
  busy: string | null;
  cover: string;
  series: string;
  setCover(v: string): void;
  setSeries(v: string): void;
  showRequest: boolean;
  setShowRequest(v: boolean): void;
  onPrepare(): void;
  onStage(): void;
  onRequest(): void;
  onCheck(): void;
  onDraft(draft: PlatformDraftDTO): void;
  onNotice(notice: Notice | undefined): void;
  onReload(): void;
}

function DraftBody(p: BodyProps) {
  const { draft, info } = p;
  const status = draft.status;
  const idBase = `pub-${info.id}`;
  const canRebuild = status !== 'publishing' && status !== 'published' && status !== 'unknown';
  const canStage = (status === 'draft' || status === 'staged' || status === 'failed') && p.errors === 0 && p.connected;
  const stageReason = !p.connected ? `Reconnect ${info.name} first.` : p.errors > 0 ? 'Fix the problems marked “Must fix” first.' : null;
  const canAsk = status === 'staged' && p.errors === 0 && p.connected;

  return (
    <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4">
      <p className="text-sm leading-relaxed text-muted-foreground">{DRAFT_STATUS_HINTS[status]}</p>

      {status === 'published' ? (
        <div className="rounded-lg border border-success/50 bg-success/10 p-3 text-sm">
          <p className="font-medium text-success">Published on {info.name}</p>
          {draft.remoteUrl ? (
            <a href={draft.remoteUrl} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 break-all font-medium text-link underline underline-offset-2">
              {draft.remoteUrl}
              <ExternalLink aria-hidden className="size-3.5 shrink-0" />
            </a>
          ) : (
            <p className="mt-1 text-muted-foreground">The platform did not return a link. Look for it on your {info.name} profile.</p>
          )}
          {draft.publishedAt ? <p className="mt-1 text-xs text-muted-foreground">{formatWhen(draft.publishedAt)}</p> : null}
        </div>
      ) : null}

      {draft.failureMessage && (status === 'failed' || status === 'unknown') ? (
        <div className={cn('rounded-lg border p-3 text-sm', status === 'unknown' ? 'border-destructive/50 bg-destructive/10' : 'border-destructive/40')} role="alert">
          <p className="font-medium">{status === 'unknown' ? 'The result is not known' : 'It did not go out'}</p>
          <p className="mt-1 break-words">{draft.failureMessage}</p>
          {draft.nextAction ? <p className="mt-1 font-medium">{draft.nextAction}</p> : null}
        </div>
      ) : null}

      {status === 'unknown' ? <UnknownResolver draft={draft} busy={p.busy} onCheck={p.onCheck} onDraft={p.onDraft} onNotice={p.onNotice} /> : null}

      {status === 'source_changed' ? (
        <div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
          <p className="font-medium">You edited the article after building this draft</p>
          <p className="mt-1 text-muted-foreground">Any approval for the old text is void. Rebuild the draft to see exactly what would be sent now.</p>
        </div>
      ) : null}

      {status === 'pending_approval' && draft.approval?.status === 'pending' ? (
        <ApprovalCard draft={draft} info={info} onDraft={p.onDraft} onNotice={p.onNotice} />
      ) : null}

      {status !== 'published' ? (
        <>
          {status === 'draft' || status === 'staged' || status === 'failed' || status === 'source_changed' ? (
            <Optional info={info} idBase={idBase} cover={p.cover} series={p.series} setCover={p.setCover} setSeries={p.setSeries} />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {status === 'source_changed' || canRebuild ? (
              <Button type="button" size="sm" variant={status === 'source_changed' ? 'default' : 'outline'} disabled={!p.saved || p.busy !== null} onClick={p.onPrepare}>
                <RefreshCw aria-hidden />
                {p.busy === 'prepare' ? 'Building' : status === 'source_changed' ? 'Rebuild draft' : 'Rebuild from the article'}
              </Button>
            ) : null}
            {status === 'draft' || status === 'staged' || status === 'failed' ? (
              <Button type="button" size="sm" variant="outline" disabled={!canStage || p.busy !== null} onClick={p.onStage} title={stageReason ?? undefined}>
                <Lock aria-hidden />
                {p.busy === 'stage' ? 'Staging' : status === 'staged' ? 'Update private draft' : 'Stage private draft'}
              </Button>
            ) : null}
            {status === 'staged' ? (
              <Button type="button" size="sm" disabled={!canAsk || p.busy !== null} onClick={p.onRequest}>
                <Send aria-hidden />
                {p.busy === 'request' ? 'Asking' : 'Request approval'}
              </Button>
            ) : null}
          </div>
          {stageReason && (status === 'draft' || status === 'staged' || status === 'failed') ? <p className="-mt-2 text-xs text-muted-foreground">{stageReason}</p> : null}
          {status === 'draft' || status === 'failed' ? <p className="-mt-2 text-xs text-muted-foreground">Stage the private draft first, then look at it on {info.name} before you ask for approval.</p> : null}
        </>
      ) : null}

      {draft.remotePreviewUrl && status !== 'published' ? (
        <a href={draft.remotePreviewUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-sm font-medium text-link underline underline-offset-2">
          Open the private draft on {info.name}
          <ExternalLink aria-hidden className="size-3.5" />
        </a>
      ) : draft.stagedAt && status !== 'published' ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {info.name} gave no link to the private draft. Find it under your drafts in the {info.name} dashboard.
        </p>
      ) : null}

      {status === 'source_changed' ? null : (
        <section aria-label="Checks">
          <h4 className="mb-2 text-sm font-semibold">Checks</h4>
          <LintList issues={draft.lint} />
        </section>
      )}

      <section aria-label="What will be sent" className={cn(status === 'source_changed' && 'opacity-60')}>
        <h4 className="mb-2 text-sm font-semibold">{status === 'source_changed' ? 'Last built version (out of date)' : 'The post'}</h4>
        <PayloadSummary draft={draft} />
        <button type="button" className="mt-2 text-xs font-medium text-link underline underline-offset-2" aria-expanded={p.showRequest} onClick={() => p.setShowRequest(!p.showRequest)}>
          {p.showRequest ? 'Hide' : 'Show'} the exact request body
        </button>
        {p.showRequest ? <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-card px-3 py-2 font-mono text-xs leading-relaxed">{draft.requestPreview}</pre> : null}
      </section>

      <section aria-label="History">
        <h4 className="mb-2 text-sm font-semibold">History</h4>
        <AttemptList attempts={draft.attempts} />
      </section>
    </div>
  );
}

function ApprovalCard({ draft, info, onDraft, onNotice }: { draft: PlatformDraftDTO; info: DestinationDTO['info']; onDraft(d: PlatformDraftDTO): void; onNotice(n: Notice | undefined): void }) {
  const approval = draft.approval!;
  const boxes = approvalChecklist(info.name, draft.payload.canonicalUrl !== null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const all = boxes.every((b) => ticked[b]);
  const approveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Date.parse(approval.expiresAt) - Date.now()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [approval.expiresAt]);

  const expired = left !== null && left <= 0;
  const minutes = left === null ? null : Math.floor(left / 60_000);
  const seconds = left === null ? null : Math.floor((left % 60_000) / 1000);

  async function approve() {
    setBusy('approve');
    onNotice(undefined);
    const result = await api<{ outcome: string; message: string; draft: PlatformDraftDTO }>(`/api/approvals/${approval.id}/approve`, {
      method: 'POST',
      json: { checked: boxes.filter((b) => ticked[b]) },
    });
    setBusy(null);
    if (result.ok) {
      onDraft(result.data.draft);
      onNotice({ tone: result.data.outcome === 'published' ? 'success' : 'error', text: result.data.message });
    } else onNotice({ tone: 'error', text: result.network ? 'Could not reach the app server. If you are unsure whether it went out, use Check on platform before trying again.' : result.error });
  }

  async function decline() {
    setBusy('decline');
    const result = await api<PlatformDraftDTO>(`/api/approvals/${approval.id}/decline`, { method: 'POST', json: {} });
    setBusy(null);
    if (result.ok) {
      onDraft(result.data);
      onNotice({ tone: 'success', text: 'Declined. Nothing was sent.' });
    } else onNotice({ tone: 'error', text: result.error });
  }

  return (
    <section aria-labelledby={`approval-${approval.id}`} className="min-w-0 rounded-xl border-2 border-warning/70 bg-card p-3.5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`approval-${approval.id}`} className=" text-base font-semibold">
          Approve this exact post
        </h4>
        <span className="rounded-md border bg-background px-2 py-0.5 font-mono text-xs font-semibold" title="Short tag of the payload hash. It changes if anything in the post changes.">
          {approval.tag}
        </span>
      </header>
      <p className="mt-1 text-xs text-muted-foreground">
        {expired ? 'This request has expired. Close it and ask again.' : minutes === null ? 'Expires in 30 minutes.' : `Expires in ${minutes}:${String(seconds).padStart(2, '0')}. Single use.`}
        {approval.requestedBy === 'agent' ? ' Requested by your agent.' : ''}
      </p>

      <dl className="mt-3 grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[6.5rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Platform</dt>
        <dd className="font-medium">{info.name}</dd>
        <dt className="text-muted-foreground">Account</dt>
        <dd className="font-medium">{draft.account ?? 'unknown'}</dd>
        <dt className="text-muted-foreground">Title</dt>
        <dd className="break-words font-medium">{draft.payload.title}</dd>
        <dt className="text-muted-foreground">Canonical URL</dt>
        <dd className="break-all">{draft.payload.canonicalUrl ?? 'not set'}</dd>
        <dt className="text-muted-foreground">Tags</dt>
        <dd className="font-mono text-xs leading-6">{draft.payload.tags.join(', ') || 'none'}</dd>
      </dl>

      <p className="mt-3 text-sm font-medium">Exactly what will be sent</p>
      <pre tabIndex={0} aria-label="The request body that will be sent" className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background px-3 py-2 font-mono text-xs leading-relaxed">
        {draft.requestPreview}
      </pre>

      <fieldset className="mt-3 grid gap-2" disabled={expired || busy !== null}>
        <legend className="mb-1 text-sm font-medium">Tick every box to approve</legend>
        {boxes.map((box) => (
          <label key={box} className="flex cursor-pointer items-start gap-2.5 text-sm leading-snug">
            <input
              type="checkbox"
              checked={Boolean(ticked[box])}
              onChange={(e) => setTicked((t) => ({ ...t, [box]: e.target.checked }))}
              className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
            />
            <span>{box}</span>
          </label>
        ))}
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button ref={approveRef} type="button" disabled={!all || expired || busy !== null} onClick={() => void approve()}>
          <Send aria-hidden />
          {busy === 'approve' ? 'Publishing' : `Approve and publish ${approval.tag}`}
        </Button>
        <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => void decline()}>
          {expired ? 'Close' : 'Decline'}
        </Button>
      </div>
      {!all ? <p className="mt-2 text-xs text-muted-foreground">The button stays off until every box is ticked.</p> : null}
    </section>
  );
}

function UnknownResolver({ draft, busy, onCheck, onDraft, onNotice }: { draft: PlatformDraftDTO; busy: string | null; onCheck(): void; onDraft(d: PlatformDraftDTO): void; onNotice(n: Notice | undefined): void }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<'posted' | 'not_posted'>('not_posted');
  const [url, setUrl] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

  async function mark() {
    setSaving(true);
    const result = await api<PlatformDraftDTO>(`/api/platform-drafts/${draft.id}/mark`, { method: 'POST', json: { outcome, confirm: true, ...(outcome === 'posted' && url.trim() ? { remoteUrl: url.trim() } : {}) } });
    setSaving(false);
    if (result.ok) {
      onDraft(result.data);
      onNotice({ tone: 'success', text: outcome === 'posted' ? 'Recorded as posted by hand.' : 'Recorded as not posted. You can ask for approval again.' });
    } else onNotice({ tone: 'error', text: result.error });
  }

  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={busy !== null} onClick={onCheck}>
          {busy === 'check' ? 'Checking' : 'Check on platform'}
        </Button>
        <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          Mark by hand
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">“Check on platform” only reads. It is safe. The post is never sent again on its own.</p>
      {open ? (
        <fieldset className="grid gap-2 rounded-md bg-muted/60 p-3">
          <legend className="sr-only">Mark the result by hand</legend>
          <p className="text-sm font-medium">Look at your dashboard first, then say what you found</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`mark-${draft.id}`} checked={outcome === 'not_posted'} onChange={() => setOutcome('not_posted')} className="accent-[var(--primary)]" />
            It is not live (a private draft at most)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`mark-${draft.id}`} checked={outcome === 'posted'} onChange={() => setOutcome('posted')} className="accent-[var(--primary)]" />
            It is live
          </label>
          {outcome === 'posted' ? <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link to the live post (optional)" aria-label="Link to the live post" inputMode="url" className="h-9" /> : null}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5 size-4 accent-[var(--primary)]" />
            <span>I checked on the platform myself and this is what I saw.</span>
          </label>
          <div>
            <Button type="button" size="sm" disabled={!confirm || saving} onClick={() => void mark()}>
              {saving ? 'Saving' : 'Record this'}
            </Button>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

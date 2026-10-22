'use client';

import { CircleCheck, CircleDashed, FlaskConical, KeyRound, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FormNotice, Input, Select } from '@/components/ui/field';
import { api } from '@/lib/api-client';
import { formatWhen } from '@/lib/format';
import { CONNECTION_STATUS_LABELS, type ConnectionDTO, type PlatformInfo } from '@/lib/publishing';
import { cn } from '@/lib/utils';

export interface ConnectionView {
  platform: PlatformInfo['id'];
  info: PlatformInfo;
  connection: ConnectionDTO | null;
}

function Capability({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b py-2 last:border-b-0 sm:flex-row sm:gap-4">
      <dt className="w-32 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function StateBadge({ connection }: { connection: ConnectionDTO | null }) {
  if (!connection) {
    return (
      <Badge variant="outline" className="gap-1.5 border-input text-muted-foreground">
        <CircleDashed aria-hidden />
        Not connected
      </Badge>
    );
  }
  const good = connection.status === 'connected';
  return (
    <Badge variant="outline" className={cn('gap-1.5', good ? 'border-success/50 text-success' : 'border-warning/60 text-warning')}>
      {good ? <CircleCheck aria-hidden /> : <TriangleAlert aria-hidden />}
      {CONNECTION_STATUS_LABELS[connection.status]}
    </Badge>
  );
}

/** Settings > Connections: add, check and remove the keys used to publish. A key is typed here and nowhere else. */
export function ConnectionsManager({ initial }: { initial: ConnectionView[] }) {
  const [views, setViews] = useState(initial);
  const replace = (platform: string, connection: ConnectionDTO | null) =>
    setViews((current) => current.map((v) => (v.platform === platform ? { ...v, connection } : v)));

  return (
    <div className="grid gap-8">
      <section aria-labelledby="how-heading" className="rounded-xl border bg-card p-4 sm:p-5">
        <h2 id="how-heading" className=" text-lg font-semibold">
          Your keys stay here
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          A key is checked with a read-only call, encrypted on this server and never shown again after you save it, not even to you. It is never sent to Claude Code, the agent API or any log. Connecting an account publishes nothing: every post still needs your approval, one at a time.
        </p>
      </section>
      <ul className="grid gap-6">
        {views.map((view) => (
          <li key={view.platform}>
            <PlatformCard view={view} onChange={(connection) => replace(view.platform, connection)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlatformCard({ view, onChange }: { view: ConnectionView; onChange(connection: ConnectionDTO | null): void }) {
  const { info, connection } = view;
  const caps = info.capabilities;
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<null | 'connect' | 'test' | 'remove' | 'publication'>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const id = `secret-${info.id}`;

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setBusy('connect');
    setNotice(null);
    setFieldError(null);
    const result = await api<ConnectionDTO>('/api/connections', { json: { platform: info.id, secret } });
    setBusy(null);
    if (result.ok) {
      setSecret('');
      setReplacing(false);
      onChange(result.data);
      setNotice({ tone: 'success', text: `Connected${result.data.who ? ` as ${result.data.who}` : ''}.` });
    } else {
      setFieldError(result.fields.secret ?? null);
      setNotice({ tone: 'error', text: result.network ? 'Could not reach the app server.' : result.error });
    }
  }

  async function test() {
    if (!connection) return;
    setBusy('test');
    setNotice(null);
    const result = await api<{ connection: ConnectionDTO; ok: boolean; message: string }>(`/api/connections/${connection.id}/test`, { method: 'POST', json: {} });
    setBusy(null);
    if (result.ok) {
      onChange(result.data.connection);
      setNotice({ tone: result.data.ok ? 'success' : 'error', text: result.data.message });
    } else setNotice({ tone: 'error', text: result.network ? 'Could not reach the app server.' : result.error });
  }

  async function remove() {
    if (!connection) return;
    setBusy('remove');
    const result = await api(`/api/connections/${connection.id}`, { method: 'DELETE' });
    setBusy(null);
    setConfirmRemove(false);
    if (result.ok) {
      onChange(null);
      setNotice({ tone: 'success', text: 'Disconnected. The saved key was deleted.' });
    } else setNotice({ tone: 'error', text: result.error });
  }

  async function choosePublication(publicationId: string) {
    if (!connection) return;
    setBusy('publication');
    const result = await api<ConnectionDTO>(`/api/connections/${connection.id}`, { method: 'PATCH', json: { publicationId } });
    setBusy(null);
    if (result.ok) onChange(result.data);
    else setNotice({ tone: 'error', text: result.error });
  }

  const showForm = !connection || replacing;
  const publications = connection?.config.publications ?? [];

  return (
    <article aria-labelledby={`${id}-name`} className="rounded-xl border bg-card p-4 sm:p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`${id}-name`} className=" text-xl font-semibold">
            {info.name}
          </h2>
          {connection?.who ? <p className="mt-0.5 text-sm text-muted-foreground">Signed in as {connection.who}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StateBadge connection={connection} />
          <Badge variant="outline" className={cn('gap-1.5', info.verification.level === 'docs_only' ? 'border-warning/60 text-warning' : 'border-input text-muted-foreground')}>
            <FlaskConical aria-hidden />
            {info.verification.label}
          </Badge>
        </div>
      </header>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{info.verification.detail}</p>

      <details className="mt-4 rounded-lg border bg-background/60 px-3 py-1">
        <summary className="cursor-pointer py-2 text-sm font-medium">What {info.name} can and cannot do here</summary>
        <dl className="pb-2">
          <Capability label="Formats">{caps.formats.join(', ')}</Capability>
          <Capability label="Private drafts">{caps.drafts ? 'Yes. A draft can be looked at before anything is public.' : 'No'}</Capability>
          <Capability label="Scheduling">Not built yet. A post goes out when you approve it.</Capability>
          <Capability label="Images">{caps.media}</Capability>
          <Capability label="Status check">{caps.statusRetrieval ? 'Yes, read-only, to find out whether a post is live.' : 'No'}</Capability>
          <Capability label="Canonical URL">{caps.canonicalUrl ? 'Yes, pointing back to your own site.' : 'No'}</Capability>
          <Capability label="Series">{caps.series ? 'Yes, by name.' : 'Not sent yet.'}</Capability>
          <Capability label="Tags">At most {caps.tagsMax}, cleaned to the platform’s form. Every change is shown.</Capability>
          <Capability label="Cost">{caps.cost}</Capability>
          <Capability label="Restrictions">
            <ul className="grid gap-1">
              {caps.restrictions.map((r) => (
                <li key={r} className="flex gap-2">
                  <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </Capability>
        </dl>
      </details>

      {connection ? (
        <dl className="mt-4 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
          <div>
            <dt className="inline">Key: </dt>
            <dd className="inline">saved, ends in {connection.keyLast4}</dd>
          </div>
          <div>
            <dt className="inline">Last checked: </dt>
            <dd className="inline">{connection.lastCheckedAt ? formatWhen(connection.lastCheckedAt) : 'never'}</dd>
          </div>
          {connection.lastCheckMessage ? (
            <div className="sm:col-span-2">
              <dt className="inline">Last problem: </dt>
              <dd className="inline">{connection.lastCheckMessage}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {connection && publications.length > 1 ? (
        <div className="mt-4 max-w-sm">
          <Field label="Publish to" htmlFor={`${id}-publication`} hint="The Hashnode publication this token can reach. Posts go here.">
            <Select id={`${id}-publication`} value={connection.config.publicationId ?? ''} disabled={busy === 'publication'} onChange={(e) => void choosePublication(e.target.value)}>
              {publications.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : connection?.config.publicationTitle ? (
        <p className="mt-3 text-xs text-muted-foreground">Publishes to {connection.config.publicationTitle}.</p>
      ) : null}

      {notice ? (
        <div className="mt-4">
          <FormNotice tone={notice.tone}>{notice.text}</FormNotice>
        </div>
      ) : null}

      {showForm ? (
        <form onSubmit={(event) => void connect(event)} className="mt-4 grid gap-3 sm:max-w-md" autoComplete="off">
          <Field label={connection ? `New ${info.secretLabel}` : info.secretLabel} htmlFor={id} hint={info.secretHelp} error={fieldError ?? undefined}>
            <Input
              id={id}
              name={id}
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              data-1p-ignore
              data-lpignore="true"
              aria-describedby={`${id}-hint`}
              aria-invalid={Boolean(fieldError)}
              placeholder="Paste the key here"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy === 'connect' || secret.trim().length === 0}>
              <KeyRound aria-hidden />
              {busy === 'connect' ? 'Checking the key' : connection ? 'Replace key' : `Connect ${info.name}`}
            </Button>
            {connection ? (
              <Button type="button" variant="ghost" onClick={() => { setReplacing(false); setSecret(''); setFieldError(null); }}>
                Cancel
              </Button>
            ) : null}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">The key is checked with a read-only request first. If {info.name} refuses it, nothing is saved.</p>
        </form>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy === 'test'} onClick={() => void test()}>
            {busy === 'test' ? 'Testing' : 'Test connection'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setReplacing(true)}>
            Replace key
          </Button>
          {confirmRemove ? (
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">Delete the saved key?</span>
              <Button type="button" size="sm" variant="destructive" disabled={busy === 'remove'} onClick={() => void remove()}>
                Disconnect
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button type="button" size="sm" variant="ghost" className="ml-auto" aria-label={`Disconnect ${info.name}`} onClick={() => setConfirmRemove(true)}>
              <Trash2 aria-hidden />
              Disconnect
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

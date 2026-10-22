'use client';

import { CircleCheck, KeyRound, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormNotice, Input, Select } from '@/components/ui/field';
import { api } from '@/lib/api-client';
import { formatWhen } from '@/lib/format';
import { CONNECTION_STATUS_LABELS, type ConnectionDTO, type PlatformInfo } from '@/lib/publishing';
import { Block, GuideSteps } from './parts';

export interface ConnectionView {
  platform: PlatformInfo['id'];
  info: PlatformInfo;
  connection: ConnectionDTO | null;
}

/**
 * Connect a platform that works today (DEV.to, Hashnode, the personal site's GitHub token). A short guide with the
 * link to the exact page, a password field that is never echoed, an automatic read-only check that says who it
 * connected as, and a clear message when it fails. "Connected" means the check passed, not that a value was saved.
 */
export function LiveConnection({ view, onChange }: { view: ConnectionView; onChange(connection: ConnectionDTO | null): void }) {
  const { info, connection } = view;
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
  const good = connection?.status === 'connected';

  return (
    <div className="grid gap-5">
      {connection ? (
        <div
          className={good ? 'flex flex-wrap items-center gap-2 rounded-lg border border-success/25 bg-success-subtle px-3 py-2 text-sm text-success' : 'flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2 text-sm text-warning'}
        >
          {good ? <CircleCheck aria-hidden className="size-4 shrink-0" /> : <TriangleAlert aria-hidden className="size-4 shrink-0" />}
          <span className="font-semibold">{CONNECTION_STATUS_LABELS[connection.status]}</span>
          {connection.who ? <span>as {connection.who}</span> : null}
          <span className="text-foreground/80">
            · key ends in {connection.keyLast4} · checked {connection.lastCheckedAt ? formatWhen(connection.lastCheckedAt) : 'never'}
          </span>
        </div>
      ) : null}
      {connection?.lastCheckMessage ? <p className="text-sm text-warning">{connection.lastCheckMessage}</p> : null}

      {connection && publications.length > 1 ? (
        <div className="max-w-sm">
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
        <p className="text-sm text-muted-foreground">Publishes to {connection.config.publicationTitle}.</p>
      ) : null}

      {notice ? <FormNotice tone={notice.tone}>{notice.text}</FormNotice> : null}

      {showForm ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Block title={connection ? 'Make a new key' : 'Get your key'}>
            <GuideSteps steps={info.connect.steps} openUrl={info.connect.openUrl} openLabel={info.connect.openLabel} />
          </Block>
          <Block title={connection ? 'Replace the saved key' : 'Paste it here'}>
            <form onSubmit={(event) => void connect(event)} className="grid gap-3" autoComplete="off">
              <Field label={info.secretLabel} htmlFor={id} hint="Checked with a read-only request. If it is refused, nothing is saved." error={fieldError ?? undefined}>
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
                  {busy === 'connect' ? 'Checking the key' : connection ? 'Replace key' : `Test and connect ${info.name}`}
                </Button>
                {connection ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setReplacing(false);
                      setSecret('');
                      setFieldError(null);
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
              <p className="text-xs leading-5 text-muted-foreground">The key is encrypted on this server and never shown again, not even to you. Connecting publishes nothing.</p>
            </form>
          </Block>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
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
    </div>
  );
}

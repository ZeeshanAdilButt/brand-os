'use client';

import { KeyRound, LogIn, Plug, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormNotice, Input, Textarea } from '@/components/ui/field';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { StatusChip } from '@/components/ui/status-chip';
import { api } from '@/lib/api-client';
import { connectorChip } from '@/lib/chips';
import { AUTH_KIND_LABELS, connectorFor, hasDeviceFlow, isOAuthConnector, takesFields, type ConnectorDefinition, type ConnectorField } from '@/lib/connectors';
import type { ConnectResult, ConnectorViewDTO, DevicePollResult, DisconnectResult, StartOAuthResult } from '@/lib/connectors/dto';
import { setupGuideFor } from '@/lib/connectors/guide';
import { formatWhen } from '@/lib/format';
import type { SiteSettingsDTO } from '@/lib/site-export';
import { Block, CopyButton } from './parts';
import { Callout, Fold, PlatformLink, ScopeList, Section, StepList } from './connect-parts';
import { SiteSetup } from './site-setup';

type Notice = { tone: 'error' | 'success'; text: string } | null;

/** What the platform said when it sent the person back, in words. */
const RESULT_TEXT: Record<string, { tone: 'error' | 'success'; text: string }> = {
  connected: { tone: 'success', text: 'Signed in and checked. The connection is ready.' },
  denied: { tone: 'error', text: 'You declined access on the platform, so nothing was connected.' },
  state: { tone: 'error', text: 'That sign-in could not be matched to this browser, or it was already used. Start it again from here.' },
  session: { tone: 'error', text: 'That sign-in was started in a different browser session. Start it again from here.' },
  exchange: { tone: 'error', text: 'The platform did not accept the sign-in. Check the app’s client ID and secret and the redirect address, then try again.' },
  check: { tone: 'error', text: 'You signed in, but the check that follows did not pass, so nothing was stored.' },
  expired: { tone: 'error', text: 'The sign-in took too long or was already used. Start it again from here.' },
  error: { tone: 'error', text: 'The sign-in could not be completed. Start it again from here.' },
};

export interface DrawerProps {
  id: string | null;
  view: ConnectorViewDTO | null;
  site: SiteSettingsDTO;
  /** The result code the platform's redirect brought back, if any. */
  result: string | null;
  onClose(): void;
  onView(view: ConnectorViewDTO): void;
  /** Open another connector's drawer (LinkedIn video points at LinkedIn). */
  onOpen(id: string): void;
  /** The next connector that is ready, so "Connect all that are ready" can go on. */
  next: { id: string; name: string } | null;
}

export function ConnectDrawer(props: DrawerProps) {
  const def = props.id ? connectorFor(props.id) : null;
  return (
    <Sheet open={Boolean(def && props.view)} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent aria-describedby={undefined}>{def && props.view ? <Body key={def.id} def={def} {...props} view={props.view} /> : null}</SheetContent>
    </Sheet>
  );
}

function PasswordInput({ id, field, value, onChange, error }: { id: string; field: ConnectorField; value: string; onChange(v: string): void; error: string | undefined }) {
  const secret = field.secret;
  return (
    <Field label={field.label} htmlFor={id} hint={`${field.formatHint} ${field.help}`} error={error}>
      <Input
        id={id}
        name={id}
        type={secret ? 'password' : field.kind === 'url' ? 'url' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        data-1p-ignore
        data-lpignore="true"
        aria-describedby={`${id}-hint`}
        aria-invalid={Boolean(error)}
        placeholder={field.placeholder ?? (secret ? 'Paste here' : '')}
        className={secret ? undefined : undefined}
      />
    </Field>
  );
}

function Body({ def, view, site, result, onClose, onView, onOpen, next }: DrawerProps & { def: ConnectorDefinition; view: ConnectorViewDTO }) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>(() => (result ? (RESULT_TEXT[result] ?? null) : null));
  const [busy, setBusy] = useState<null | 'connect' | 'test' | 'disconnect' | 'start' | 'app' | 'device' | 'remove-app'>(null);
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [instance, setInstance] = useState('');
  const [app, setApp] = useState({ clientId: '', clientSecret: '' });
  const [deviceApp, setDeviceApp] = useState({ clientId: '', clientSecret: '' });
  const [siteRepo, setSiteRepo] = useState(site.repo);
  const [afterDisconnect, setAfterDisconnect] = useState<DisconnectResult | null>(null);

  const chip = connectorChip(view.state);
  const connection = view.connection;
  const manual = def.kind === 'manual_only';
  const unverified = !manual && def.verification.level === 'unverified';
  const guide = useMemo(() => setupGuideFor(def, view.redirectUri), [def, view.redirectUri]);
  const oauth = isOAuthConnector(def);
  const pasted = takesFields(def) && !unverified && !(oauth);
  const device = hasDeviceFlow(def);
  const showForm = pasted && (!connection || replacing);

  async function submitFields(event: React.FormEvent) {
    event.preventDefault();
    setBusy('connect');
    setNotice(null);
    setErrors({});
    const result = await api<ConnectResult>(`/api/connect/${def.id}/fields`, { json: { fields } });
    setBusy(null);
    if (result.ok) {
      setFields({});
      setReplacing(false);
      onView(result.data.view);
      setNotice({ tone: 'success', text: result.data.message });
    } else {
      setErrors(result.fields);
      setNotice({ tone: 'error', text: result.network ? 'Could not reach the app server.' : result.error });
    }
  }

  async function test() {
    setBusy('test');
    setNotice(null);
    const result = await api<ConnectResult>(`/api/connect/${def.id}/test`, { method: 'POST', json: {} });
    setBusy(null);
    if (result.ok) {
      onView(result.data.view);
      setNotice({ tone: result.data.ok ? 'success' : 'error', text: result.data.message });
    } else setNotice({ tone: 'error', text: result.network ? 'Could not reach the app server.' : result.error });
  }

  async function disconnect() {
    setBusy('disconnect');
    const result = await api<DisconnectResult>(`/api/connect/${def.id}`, { method: 'DELETE' });
    setBusy(null);
    setConfirmRemove(false);
    if (result.ok) {
      setAfterDisconnect(result.data);
      onView(result.data.view);
      setNotice(null);
    } else setNotice({ tone: 'error', text: result.error });
  }

  async function saveApp(kind: 'oauth_client' | 'device_client', values: { clientId: string; clientSecret: string }) {
    setBusy('app');
    setNotice(null);
    setErrors({});
    const result = await api<{ hint: string }>(`/api/integrations/${def.id}`, { method: 'PUT', json: { kind, clientId: values.clientId, ...(values.clientSecret ? { clientSecret: values.clientSecret } : {}) } });
    if (!result.ok) {
      setBusy(null);
      setErrors(result.fields);
      setNotice({ tone: 'error', text: result.network ? 'Could not reach the app server.' : result.error });
      return;
    }
    const list = await api<{ connectors: ConnectorViewDTO[] }>('/api/connect');
    setBusy(null);
    if (kind === 'oauth_client') setApp({ clientId: '', clientSecret: '' });
    else setDeviceApp({ clientId: '', clientSecret: '' });
    const fresh = list.ok ? list.data.connectors.find((c) => c.id === def.id) : null;
    if (fresh) onView(fresh);
    setNotice({ tone: 'success', text: 'Saved. It is encrypted and never shown again.' });
  }

  async function removeApp(kind: 'oauth_client' | 'device_client' | 'api_key') {
    setBusy('remove-app');
    const result = await api(`/api/integrations/${def.id}/${kind}`, { method: 'DELETE' });
    const list = await api<{ connectors: ConnectorViewDTO[] }>('/api/connect');
    setBusy(null);
    if (!result.ok) setNotice({ tone: 'error', text: result.error });
    else {
      const fresh = list.ok ? list.data.connectors.find((c) => c.id === def.id) : null;
      if (fresh) onView(fresh);
    }
  }

  async function startSignIn() {
    setBusy('start');
    setNotice(null);
    setErrors({});
    const optional = def.scopes.filter((s) => !s.required && chosen.has(s.name)).map((s) => s.name);
    const result = await api<StartOAuthResult>(`/api/connect/${def.id}/start`, { json: { scopes: optional, ...(def.oauth?.perInstance ? { instance } : {}) } });
    if (!result.ok) {
      setBusy(null);
      setErrors(result.fields);
      setNotice({ tone: 'error', text: result.network ? 'Could not reach the app server.' : result.error });
      return;
    }
    // Leave for the platform. The page it sends the person back to opens this drawer again with the result.
    window.location.assign(result.data.authorizeUrl);
  }

  async function askForCode() {
    setBusy('device');
    setNotice(null);
    const result = await api<unknown>(`/api/connect/${def.id}/device`, { json: {} });
    if (!result.ok) {
      setBusy(null);
      setNotice({ tone: 'error', text: result.network ? 'Could not reach the app server.' : result.error });
      return;
    }
    const list = await api<{ connectors: ConnectorViewDTO[] }>('/api/connect');
    setBusy(null);
    const fresh = list.ok ? list.data.connectors.find((c) => c.id === def.id) : null;
    if (fresh) onView(fresh);
  }

  async function cancelCode() {
    const result = await api<ConnectorViewDTO>(`/api/connect/${def.id}/device`, { method: 'DELETE' });
    if (result.ok) onView(result.data);
  }

  const reconnectNote = view.state === 'needs_reconnect' || view.reconnect;

  return (
    <>
      <header className="flex items-start gap-3 border-b px-5 py-4 sm:px-6">
        <div className="grid min-w-0 flex-1 gap-1.5">
          <SheetTitle>{def.name}</SheetTitle>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip chip={chip} />
            <span className="mono-label text-muted-foreground">{AUTH_KIND_LABELS[def.kind]}</span>
          </div>
          <SheetDescription>{def.summary}</SheetDescription>
        </div>
        <SheetClose />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {notice ? (
          <div className="px-5 pt-4 sm:px-6">
            <FormNotice tone={notice.tone}>{notice.text}</FormNotice>
            {notice.tone === 'success' && next && view.state === 'connected' ? (
              <Button type="button" className="mt-3" onClick={() => onOpen(next.id)}>
                Next: {next.name}
              </Button>
            ) : null}
          </div>
        ) : null}

        {afterDisconnect ? (
          <Section title="Disconnected">
            <Callout tone="info">{afterDisconnect.message}</Callout>
            {afterDisconnect.steps.length > 0 ? (
              <ol className="grid gap-1.5 pl-5 text-sm leading-6">
                {afterDisconnect.steps.map((s) => (
                  <li key={s} className="list-decimal">
                    {s}
                  </li>
                ))}
              </ol>
            ) : null}
            {def.revoke?.manualUrl && afterDisconnect.steps.length > 0 ? <PlatformLink href={def.revoke.manualUrl}>Open the page on {def.name}</PlatformLink> : null}
          </Section>
        ) : null}

        {connection ? (
          <Section title="Connection">
            <div className={view.state === 'connected' && !reconnectNote ? 'grid gap-2 rounded-lg border border-success/25 bg-success-subtle px-3 py-3 text-sm' : 'grid gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-3 py-3 text-sm'}>
              <p className="font-semibold">{connection.who ? `Connected as ${connection.who}` : 'Connected'}</p>
              <p className="text-foreground/80">
                {view.detail} Checked {connection.lastCheckedAt ? formatWhen(connection.lastCheckedAt) : 'never'}.
                {connection.keyLast4 ? ` Key ends in ${connection.keyLast4}.` : ''}
              </p>
              {connection.lastCheckMessage && connection.lastErrorCode ? <p className="text-foreground/80">{connection.lastCheckMessage}</p> : null}
              {connection.scopesGranted.length > 0 ? (
                <p className="text-xs text-foreground/70">
                  Allowed: <span className="font-mono">{connection.scopesGranted.join(' ')}</span>
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" disabled={busy === 'test' || manual} onClick={() => void test()}>
                <RefreshCw aria-hidden />
                {busy === 'test' ? 'Testing' : 'Test'}
              </Button>
              {reconnectNote && oauth ? (
                <Button type="button" onClick={() => document.getElementById(`${def.id}-signin`)?.scrollIntoView({ block: 'center' })}>
                  <LogIn aria-hidden />
                  Reconnect
                </Button>
              ) : null}
              {pasted ? (
                <Button type="button" variant={reconnectNote ? 'default' : 'ghost'} onClick={() => setReplacing(true)}>
                  {def.kind === 'webhook_url' ? 'Replace address' : 'Replace key'}
                </Button>
              ) : null}
              {def.sharesWith ? null : confirmRemove ? (
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">Delete the stored secret?</span>
                  <Button type="button" variant="destructive" disabled={busy === 'disconnect'} onClick={() => void disconnect()}>
                    Disconnect
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <Button type="button" variant="ghost" className="ml-auto" aria-label={`Disconnect ${def.name}`} onClick={() => setConfirmRemove(true)}>
                  <Trash2 aria-hidden />
                  Disconnect
                </Button>
              )}
            </div>
          </Section>
        ) : null}

        {manual && def.manual ? (
          <Section title="Why there is nothing to connect">
            <Callout tone="info">{def.manual.reason}</Callout>
            <p className="text-sm font-medium">What you do instead</p>
            <StepList steps={def.manual.handoff.map((body, i) => ({ title: `Step ${i + 1}`, body }))} />
            <PlatformLink href={def.manual.openUrl}>{def.manual.openLabel}</PlatformLink>
          </Section>
        ) : null}

        {unverified ? (
          <Section title="Not connected yet" hint="Brand OS only connects what it could confirm on the platform's own documentation.">
            <Callout tone="warn" title="This stays at Set up">
              <ul className="grid gap-1 pl-4">
                {def.verification.unverified.map((u) => (
                  <li key={u} className="list-disc">
                    {u}
                  </li>
                ))}
              </ul>
            </Callout>
            {def.steps.length > 0 ? <StepList steps={def.steps} /> : null}
            <PlatformLink href={def.docsUrl}>Open the official documentation</PlatformLink>
          </Section>
        ) : null}

        {def.sharesWith ? (
          <Section title="Uses another sign-in">
            <Callout tone="info">{def.steps[0]?.body}</Callout>
            <div>
              <Button type="button" onClick={() => onOpen(def.sharesWith as string)}>
                <Plug aria-hidden />
                Open {connectorFor(def.sharesWith)?.name ?? 'the other sign-in'}
              </Button>
            </div>
          </Section>
        ) : null}

        {def.id === 'site' ? (
          <Section title="Where your site lives" hint="Markdown export works with just this. A pull request also needs a token for the repository.">
            <SiteSetup initial={site} onSaved={(s) => setSiteRepo(s.repo)} />
          </Section>
        ) : null}

        {pasted && (!connection || replacing || reconnectNote) ? (
          <>
            <Section title="Steps">
              <StepList steps={def.steps} />
            </Section>
            <Section title="What this allows" hint="The least access the platform lets this connection ask for.">
              <ScopeList scopes={def.scopes} idPrefix={def.id} />
            </Section>
          </>
        ) : null}

        {showForm ? (
          <Section title={connection ? 'Replace' : 'Connect'} hint="Checked with one read-only request before anything is stored. If the platform refuses it, nothing is saved.">
            <form onSubmit={(e) => void submitFields(e)} className="grid gap-4" autoComplete="off" noValidate>
              {def.fields.map((field) => (
                <PasswordInput key={field.id} id={`${def.id}-${field.id}`} field={field} value={fields[field.id] ?? ''} onChange={(v) => setFields((f) => ({ ...f, [field.id]: v }))} error={errors[field.id]} />
              ))}
              {def.id === 'site' && !siteRepo ? <Callout tone="warn">Save the repository above first. The token is checked against that repository.</Callout> : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" size="lg" disabled={busy === 'connect' || def.fields.some((f) => f.required && !(fields[f.id] ?? '').trim()) || (def.id === 'site' && !siteRepo)}>
                  <KeyRound aria-hidden />
                  {busy === 'connect' ? 'Checking' : connection ? 'Test and replace' : `Test and connect`}
                </Button>
                {connection ? (
                  <Button type="button" variant="ghost" onClick={() => { setReplacing(false); setFields({}); setErrors({}); }}>
                    Cancel
                  </Button>
                ) : null}
              </div>
              <p className="text-xs leading-5 text-muted-foreground">Encrypted on this server and never shown again, not even to you. Connecting publishes nothing.</p>
              {view.legacyKeyHint ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  A key saved earlier (ends in {view.legacyKeyHint}) is replaced when this connects.{' '}
                  <button type="button" className="font-medium text-link hover:underline" onClick={() => void removeApp('api_key')}>
                    Remove it now
                  </button>
                </p>
              ) : null}
            </form>
          </Section>
        ) : null}

        {oauth && def.oauth ? (
          <>
            {!def.oauth.perInstance ? (
              <Section title="1. Your app" hint="You register an app on the platform once. Brand OS keeps its client ID and secret encrypted.">
                {view.app.saved && view.app.source === 'host' ? (
                  <Callout tone="good">This server provides the Brand OS app for {def.name}. Nothing to register.</Callout>
                ) : (
                  <>
                    {view.app.saved ? (
                      <Callout tone="good">
                        App saved (client ID ends in <span className="font-mono">{view.app.hint}</span>).{' '}
                        <button type="button" className="font-medium text-link hover:underline" disabled={busy === 'remove-app'} onClick={() => void removeApp('oauth_client')}>
                          Remove
                        </button>
                      </Callout>
                    ) : (
                      <StepList steps={def.oauth.appSteps} />
                    )}
                    {view.redirectUri ? (
                      <div className="grid gap-1.5">
                        <p className="text-sm font-medium">Redirect address to register</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-2 font-mono text-xs break-all">{view.redirectUri}</code>
                          <CopyButton text={view.redirectUri} />
                        </div>
                        <p className="text-xs leading-5 text-muted-foreground">{def.oauth.redirectNote}</p>
                      </div>
                    ) : null}
                    <Folded open={!view.app.saved} title="Replace the app">
                    <form
                      autoComplete="off"
                      className="grid gap-4"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveApp('oauth_client', app);
                      }}
                    >
                      <Field label="Client ID" htmlFor={`${def.id}-client-id`} hint="From the platform's app page." error={errors.clientId}>
                        <Input id={`${def.id}-client-id`} type="password" autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" placeholder="Paste here" value={app.clientId} onChange={(e) => setApp((a) => ({ ...a, clientId: e.target.value }))} aria-invalid={Boolean(errors.clientId)} />
                      </Field>
                      <Field label="Client secret" htmlFor={`${def.id}-client-secret`} hint="Shown once by the platform. Never displayed again here." error={errors.clientSecret}>
                        <Input id={`${def.id}-client-secret`} type="password" autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" placeholder="Paste here" value={app.clientSecret} onChange={(e) => setApp((a) => ({ ...a, clientSecret: e.target.value }))} aria-invalid={Boolean(errors.clientSecret)} />
                      </Field>
                      <div>
                        <Button type="submit" variant="outline" disabled={busy === 'app' || !app.clientId.trim() || (def.id !== 'youtube' && !app.clientSecret.trim())}>
                          {busy === 'app' ? 'Saving' : view.app.saved ? 'Replace the app' : 'Save the app'}
                        </Button>
                      </div>
                    </form>
                    </Folded>
                    <PlatformLink href={def.oauth.appUrl}>Open the platform&apos;s developer page</PlatformLink>
                  </>
                )}
              </Section>
            ) : null}

            <Section title={def.oauth.perInstance ? '1. Your instance' : '2. What to allow'} hint="Required access is always included. Optional access is off until you tick it.">
              {def.oauth.perInstance ? (
                <Field label={def.fields[0]?.label ?? 'Your instance'} htmlFor={`${def.id}-instance`} hint={def.fields[0]?.formatHint ?? ''} error={errors.instance}>
                  <Input id={`${def.id}-instance`} type="url" value={instance} onChange={(e) => setInstance(e.target.value)} placeholder={def.fields[0]?.placeholder ?? 'https://'} autoComplete="off" spellCheck={false} />
                </Field>
              ) : null}
              <ScopeList scopes={def.scopes} chosen={chosen} idPrefix={def.id} onToggle={(name, on) => setChosen((c) => { const n = new Set(c); if (on) n.add(name); else n.delete(name); return n; })} />
            </Section>

            <Section title={def.oauth.perInstance ? '2. Sign in' : '3. Sign in'} hint={def.tokens?.note}>
              <StepList steps={def.steps} />
              <div id={`${def.id}-signin`}>
                <Button type="button" size="lg" disabled={busy === 'start' || (!view.app.saved && !def.oauth.perInstance) || (def.oauth.perInstance && !instance.trim())} onClick={() => void startSignIn()}>
                  <LogIn aria-hidden />
                  {busy === 'start' ? 'Opening' : connection ? `Reconnect ${def.name}` : `Sign in with ${def.name}`}
                </Button>
                {!view.app.saved && !def.oauth.perInstance ? <p className="mt-2 text-xs text-muted-foreground">Save your app first.</p> : null}
              </div>
            </Section>
          </>
        ) : null}

        {device && def.device && !unverified ? (
          <Section title={oauth ? 'Or sign in with a code' : 'Or sign in with a code instead of a token'} hint={def.device.note}>
            {view.device ? (
              <DeviceCode device={view.device} id={def.id} onView={onView} onNotice={setNotice} onCancel={() => void cancelCode()} />
            ) : (
              <>
                {view.deviceApp.saved && view.deviceApp.source === 'saved' ? (
                  <Callout tone="good">
                    Device client saved (ends in <span className="font-mono">{view.deviceApp.hint}</span>).{' '}
                    <button type="button" className="font-medium text-link hover:underline" onClick={() => void removeApp('device_client')}>
                      Remove
                    </button>
                  </Callout>
                ) : view.deviceApp.source === 'host' ? (
                  <Callout tone="good">This server provides the device client.</Callout>
                ) : (
                  <>
                    <StepList steps={def.device.appSteps} />
                    <form
                      autoComplete="off"
                      className="grid gap-4"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveApp('device_client', deviceApp);
                      }}
                    >
                      <Field label="Client ID" htmlFor={`${def.id}-device-id`} hint="From the platform's app page." error={errors.clientId}>
                        <Input id={`${def.id}-device-id`} type="password" autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" placeholder="Paste here" value={deviceApp.clientId} onChange={(e) => setDeviceApp((a) => ({ ...a, clientId: e.target.value }))} />
                      </Field>
                      {def.device.sendClientSecret ? (
                        <Field label="Client secret" htmlFor={`${def.id}-device-secret`} hint="Needed to ask whether the code was entered." error={errors.clientSecret}>
                          <Input id={`${def.id}-device-secret`} type="password" autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" placeholder="Paste here" value={deviceApp.clientSecret} onChange={(e) => setDeviceApp((a) => ({ ...a, clientSecret: e.target.value }))} />
                        </Field>
                      ) : null}
                      <div>
                        <Button type="submit" variant="outline" disabled={busy === 'app' || !deviceApp.clientId.trim() || (def.device.sendClientSecret && !deviceApp.clientSecret.trim())}>
                          {busy === 'app' ? 'Saving' : 'Save the device client'}
                        </Button>
                      </div>
                    </form>
                  </>
                )}
                <ScopeList scopes={def.device.scopes} idPrefix={`${def.id}-device`} />
                <div>
                  <Button type="button" variant="outline" disabled={busy === 'device' || !view.deviceApp.saved} onClick={() => void askForCode()}>
                    {busy === 'device' ? 'Asking' : 'Show me a code'}
                  </Button>
                </div>
              </>
            )}
          </Section>
        ) : null}

        <Section title="Set this up with your own browser agent" hint="Optional. A guide you can give to your own Claude with browser access.">
          <Fold title="Show the setup guide">
            <Textarea readOnly value={guide} rows={12} aria-label={`Setup guide for ${def.name}`} className="font-mono text-xs leading-5" />
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton text={guide} label="Copy the guide" />
            </div>
            <p className="text-xs leading-5 text-muted-foreground">The guide lists steps only. You type every secret yourself in the fields here: nothing sensitive goes through chat or an agent.</p>
          </Fold>
        </Section>

        {!manual && def.revoke ? (
          <Section title="Take access away">
            <Fold title="How to end it on the platform">
              <Block title="Disconnect here, then finish on the platform">
                <ol className="grid gap-1.5 pl-5">
                  {def.revoke.manualSteps.map((s) => (
                    <li key={s} className="list-decimal">
                      {s}
                    </li>
                  ))}
                </ol>
                {def.revoke.provider ? <p className="text-xs text-muted-foreground">Disconnect also asks the platform to revoke the grant: {def.revoke.provider.note}</p> : <p className="text-xs text-muted-foreground">This platform has no revoke call this app can use, so Disconnect deletes the stored secret and the steps above end the access.</p>}
                {def.revoke.manualUrl ? <PlatformLink href={def.revoke.manualUrl}>Open the page on {def.name}</PlatformLink> : null}
              </Block>
            </Fold>
          </Section>
        ) : null}

        <Section title="What was checked">
          <Fold title={def.verification.level === 'verified' ? `Read on the official pages on ${def.verification.checkedOn}` : `Not fully confirmed (${def.verification.checkedOn})`}>
            <ul className="grid gap-1 pl-4">
              {def.verification.sources.map((s) => (
                <li key={s} className="list-disc break-all">
                  <a href={s} target="_blank" rel="noreferrer noopener" className="text-link hover:underline">
                    {s}
                  </a>
                </li>
              ))}
            </ul>
            {def.verification.unverified.length > 0 ? (
              <>
                <p className="font-medium">Not confirmed (UNVERIFIED)</p>
                <ul className="grid gap-1 pl-4">
                  {def.verification.unverified.map((u) => (
                    <li key={u} className="list-disc">
                      {u}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {def.validation ? (
              <p className="text-xs text-muted-foreground">
                The check: {def.validation.method} <span className="font-mono break-all">{def.validation.url}</span>. It only reads. Account name: {def.validation.account}.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">Nothing here has been tried against a real account yet. The first live check is yours.</p>
          </Fold>
        </Section>
      </div>

      <footer className="flex items-center justify-end gap-2 border-t px-5 py-3 sm:px-6">
        <Button type="button" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </footer>
    </>
  );
}

/** Open when there is nothing saved yet; folded away once there is. */
function Folded({ open, title, children }: { open: boolean; title: string; children: React.ReactNode }) {
  return open ? <>{children}</> : <Fold title={title}>{children}</Fold>;
}

/** The code to type on the platform, how long it lasts, and the polling that waits for it. */
function DeviceCode({ device, id, onView, onNotice, onCancel }: { device: NonNullable<ConnectorViewDTO['device']>; id: string; onView(view: ConnectorViewDTO): void; onNotice(n: Notice): void; onCancel(): void }) {
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.round((new Date(device.expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [device.expiresAt]);

  // The callbacks live in a ref so a new function from the parent never restarts the wait.
  const callbacks = useRef({ onView, onNotice });
  useEffect(() => {
    callbacks.current = { onView, onNotice };
  });

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      const result = await api<DevicePollResult>(`/api/connect/${id}/device/poll`, { json: { flowId: device.flowId } });
      if (stopped) return;
      if (!result.ok) {
        callbacks.current.onNotice({ tone: 'error', text: result.network ? 'Could not reach the app server.' : result.error });
        const list = await api<{ connectors: ConnectorViewDTO[] }>('/api/connect');
        const fresh = list.ok ? list.data.connectors.find((c) => c.id === id) : null;
        if (fresh && !stopped) callbacks.current.onView(fresh);
        return;
      }
      const data = result.data;
      if (data.state === 'connected') {
        callbacks.current.onView(data.view);
        callbacks.current.onNotice({ tone: 'success', text: `Connected as ${data.account}.` });
      } else if (data.state === 'pending') {
        timer = window.setTimeout(() => void poll(), Math.max(data.retryAfterSec, data.intervalSec) * 1000);
      } else {
        callbacks.current.onNotice({ tone: 'error', text: data.message });
        const list = await api<{ connectors: ConnectorViewDTO[] }>('/api/connect');
        const fresh = list.ok ? list.data.connectors.find((c) => c.id === id) : null;
        if (fresh && !stopped) callbacks.current.onView(fresh);
      }
    };
    timer = window.setTimeout(() => void poll(), device.intervalSec * 1000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [device.flowId, device.intervalSec, id]);

  return (
    <div className="grid gap-3">
      <p className="text-sm">Type this code on the platform:</p>
      <p aria-label="Your code" className="w-fit rounded-lg border-[1.5px] border-border-strong bg-muted px-4 py-3 font-mono text-2xl font-semibold tracking-widest">
        {device.userCode}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <PlatformLink href={device.verificationUri}>Open {new URL(device.verificationUri).host}</PlatformLink>
        <CopyButton text={device.userCode} label="Copy the code" />
      </div>
      <p className="text-xs leading-5 text-muted-foreground" aria-live="polite">
        Waiting for you{left !== null ? `. The code lasts ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more` : ''}.
      </p>
      <div>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

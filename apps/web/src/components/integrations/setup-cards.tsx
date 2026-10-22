'use client';

import { CalendarClock, ExternalLink, KeyRound, Lock } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormNotice, Input, Textarea } from '@/components/ui/field';
import { api } from '@/lib/api-client';
import { assistedPrompt, redirectUrl, type DirectoryEntry, type SecretKind } from '@/lib/directory';
import type { SavedCredentialDTO } from '@/server/actions/integrations';
import { Block, CopyButton, GuideSteps, SavedNote } from './parts';

type Saved = SavedCredentialDTO[];

/** Save or wipe one stored value for an integration that is not built yet. Never echoes what was typed after it is sent. */
function useStore(entry: DirectoryEntry, onSaved: (saved: Saved) => void, saved: Saved) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function save(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    const result = await api<SavedCredentialDTO & { platform: string }>(`/api/integrations/${entry.id}`, { method: 'PUT', json: body });
    setBusy(false);
    if (!result.ok) {
      setFields(result.fields);
      setError(result.network ? 'Could not reach the app server.' : result.error);
      return false;
    }
    setFields({});
    const { kind, hint, savedAt } = result.data;
    onSaved([...saved.filter((s) => s.kind !== kind), { kind, hint, savedAt }]);
    return true;
  }

  async function remove(kind: SecretKind) {
    setBusy(true);
    setError(null);
    const result = await api(`/api/integrations/${entry.id}/${kind}`, { method: 'DELETE' });
    setBusy(false);
    if (result.ok) onSaved(saved.filter((s) => s.kind !== kind));
    else setError(result.error);
  }

  return { busy, error, fields, save, remove };
}

function PasswordField({ id, label, hint, value, onChange, error }: { id: string; label: string; hint: string; value: string; onChange(v: string): void; error?: string | undefined }) {
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error}>
      <Input
        id={id}
        name={id}
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        data-1p-ignore
        data-lpignore="true"
        aria-describedby={`${id}-hint`}
        aria-invalid={Boolean(error)}
        placeholder="Paste here"
      />
    </Field>
  );
}

/** A key for a platform whose adapter is not built yet: guide, secure field, and "Saved. Not used yet." */
export function KeySetup({ entry, saved, onSaved, hideGuide = false }: { entry: DirectoryEntry; saved: Saved; onSaved(saved: Saved): void; hideGuide?: boolean }) {
  const store = useStore(entry, onSaved, saved);
  const [secret, setSecret] = useState('');
  const current = saved.find((s) => s.kind === 'api_key');
  const id = `key-${entry.id}`;
  return (
    <div className="grid gap-5">
      <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-sm leading-6">
        <CalendarClock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span>
          {entry.name} cannot be connected yet{entry.roadmap ? ` (${entry.roadmap})` : ''}. You can save your key now so it is ready; it is encrypted, not used for anything yet, and you can remove it any time.
        </span>
      </p>
      {current ? <SavedNote hint={current.hint} what="The key" busy={store.busy} onRemove={() => void store.remove('api_key')} /> : null}
      {store.error ? <FormNotice tone="error">{store.error}</FormNotice> : null}
      <div className="grid gap-5 lg:grid-cols-2">
        {entry.assisted && !hideGuide ? (
          <Block title="Get your key">
            <GuideSteps steps={entry.assisted.steps} openUrl={entry.assisted.consoleUrl} openLabel={entry.assisted.consoleLabel} />
          </Block>
        ) : null}
        <Block title={current ? 'Replace the saved key' : 'Paste it here'}>
          <form
            autoComplete="off"
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void store.save({ kind: 'api_key', secret }).then((ok) => {
                if (ok) setSecret('');
              });
            }}
          >
            <PasswordField id={id} label={entry.secretLabel || `${entry.name} key`} hint={entry.secretHelp || 'Paste the key once. It is never shown again.'} value={secret} onChange={setSecret} error={store.fields.secret} />
            <div>
              <Button type="submit" disabled={store.busy || secret.trim().length === 0}>
                <Lock aria-hidden />
                {store.busy ? 'Saving' : 'Save, not used yet'}
              </Button>
            </div>
          </form>
        </Block>
      </div>
    </div>
  );
}

/** An OAuth app: what to register once, the exact redirect address and scopes, a form for the client id and secret, and a disabled Connect. */
export function OAuthSetup({ entry, saved, onSaved, appUrl }: { entry: DirectoryEntry; saved: Saved; onSaved(saved: Saved): void; appUrl: string }) {
  const store = useStore(entry, onSaved, saved);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const current = saved.find((s) => s.kind === 'oauth_client');
  const redirect = redirectUrl(entry, appUrl);
  const oauth = entry.oauth;
  const id = `oauth-${entry.id}`;
  return (
    <div className="grid gap-5">
      <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-sm leading-6">
        <CalendarClock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span>
          The OAuth connect flow is the next piece of work after this release, so the Connect button below stays off for now. You can register the app and save its details today; they are encrypted and not used until the flow lands.
        </span>
      </p>
      <div className="grid gap-5 lg:grid-cols-2">
        <Block title="Register once">
          {oauth ? (
            <ul className="grid gap-1.5 pl-4 text-sm leading-6">
              {oauth.register.map((r) => (
                <li key={r} className="list-disc">
                  {r}
                </li>
              ))}
            </ul>
          ) : null}
          {entry.assisted ? <GuideSteps steps={entry.assisted.steps} openUrl={entry.assisted.consoleUrl} openLabel={entry.assisted.consoleLabel} /> : null}
          {redirect ? (
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">Redirect URL to register</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">{redirect}</code>
                <CopyButton text={redirect} />
              </div>
            </div>
          ) : null}
          {oauth && oauth.scopes.length > 0 ? (
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">Scopes to request</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {oauth.scopes.map((scope) => (
                  <code key={scope} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {scope}
                  </code>
                ))}
                <CopyButton text={oauth.scopes.join(' ')} label="Copy all" size="xs" variant="ghost" />
              </div>
            </div>
          ) : null}
          {oauth?.note ? <p className="text-xs leading-5 text-muted-foreground">{oauth.note}</p> : null}
        </Block>
        <Block title="Save the client details">
          {current ? <SavedNote hint={current.hint} what="The client ID" busy={store.busy} onRemove={() => void store.remove('oauth_client')} /> : null}
          {store.error ? <FormNotice tone="error">{store.error}</FormNotice> : null}
          <form
            autoComplete="off"
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void store.save({ kind: 'oauth_client', clientId, clientSecret }).then((ok) => {
                if (ok) {
                  setClientId('');
                  setClientSecret('');
                }
              });
            }}
          >
            <PasswordField id={`${id}-id`} label="Client ID" hint="Copied from the platform’s console. Stored encrypted." value={clientId} onChange={setClientId} error={store.fields.clientId} />
            <PasswordField id={`${id}-secret`} label="Client secret" hint="Shown once by the platform. Never displayed again here." value={clientSecret} onChange={setClientSecret} error={store.fields.clientSecret} />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={store.busy || clientId.trim() === '' || clientSecret.trim() === ''}>
                <Lock aria-hidden />
                {store.busy ? 'Saving' : 'Save, not used yet'}
              </Button>
              <Button type="button" variant="outline" disabled title="The OAuth connect flow is not built yet">
                <KeyRound aria-hidden />
                Connect {entry.name}
              </Button>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">Connect is off until the OAuth flow exists. Nothing here contacts {entry.name}.</p>
          </form>
        </Block>
      </div>
    </div>
  );
}

/** Assisted setup: a step list, a ready-made prompt for the owner’s own Claude with browser access, and the secure field for the result. */
export function AssistedSetup({ entry, saved, onSaved, appUrl }: { entry: DirectoryEntry; saved: Saved; onSaved(saved: Saved): void; appUrl: string }) {
  const prompt = assistedPrompt(entry, appUrl);
  return (
    <div className="grid gap-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <Block title="Assisted setup: the steps">
          <GuideSteps steps={entry.assisted?.steps ?? []} openUrl={entry.assisted?.consoleUrl ?? entry.url} openLabel={entry.assisted?.consoleLabel ?? `Open ${entry.name}`} />
        </Block>
        <Block title="Or give this to your own Claude with browser access">
          <Textarea readOnly value={prompt} rows={11} aria-label={`Prompt for setting up ${entry.name}`} className="font-mono text-xs leading-5" />
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton text={prompt} label="Copy the prompt" />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            The prompt tells Claude to create the key and stop. It never asks you to paste a secret into the chat: you copy the key yourself into the secure field next to it.
          </p>
        </Block>
      </div>
      <KeySetup entry={entry} saved={saved} onSaved={onSaved} hideGuide />
    </div>
  );
}

/** A platform with no API: what the app does for it instead. */
export function ManualNote({ entry }: { entry: DirectoryEntry }) {
  return (
    <div className="grid gap-3 text-sm leading-6">
      <p>
        <strong className="font-semibold">Nothing to connect.</strong> {entry.directoryOnly ? 'This is a directory entry for now: no live data is read and nothing can be sent.' : 'There is no API for this, so the app prepares everything and you post it yourself.'}
      </p>
      <p>{entry.plan}</p>
      <a href={entry.url} target="_blank" rel="noreferrer noopener" className="inline-flex w-fit items-center gap-1.5 font-medium text-link hover:underline">
        {entry.name} on the web
        <ExternalLink aria-hidden className="size-3.5" />
      </a>
    </div>
  );
}

'use client';

import { Check, Copy, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FormNotice, Input } from '@/components/ui/field';
import { AGENT_SCOPES, SCOPE_LABELS, type AgentScope, type CredentialDTO } from '@/lib/agent';
import { api } from '@/lib/api-client';
import { formatWhen } from '@/lib/format';

/** Create, view and revoke the credentials that let your own agents (Claude Code over MCP) reach your account. */
export function CredentialsManager({ initial }: { initial: CredentialDTO[] }) {
  const [credentials, setCredentials] = useState(initial);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<AgentScope[]>(['read']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fields: Record<string, string> } | null>(null);
  const [fresh, setFresh] = useState<{ secret: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  function toggle(scope: AgentScope) {
    setScopes((current) => (current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope]));
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await api<{ credential: CredentialDTO; secret: string }>('/api/agent-credentials', { method: 'POST', json: { name, scopes } });
    setBusy(false);
    if (!result.ok) {
      setError({ message: result.network ? 'Could not reach the server.' : result.error, fields: result.fields });
      return;
    }
    setCredentials((current) => [result.data.credential, ...current]);
    setFresh({ secret: result.data.secret, name: result.data.credential.name });
    setCopied(false);
    setName('');
    setScopes(['read']);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function revoke(id: string) {
    const result = await api<CredentialDTO>(`/api/agent-credentials/${id}`, { method: 'DELETE' });
    setConfirming(null);
    if (result.ok) setCredentials((current) => current.map((c) => (c.id === id ? result.data : c)));
    else setError({ message: result.error, fields: {} });
  }

  const active = credentials.filter((c) => !c.revokedAt);
  const revoked = credentials.filter((c) => c.revokedAt);

  return (
    <div className="grid gap-10">
      {fresh ? (
        <section aria-labelledby="fresh-heading" className="rounded-xl border-2 border-primary/50 bg-card p-4 sm:p-5">
          <h2 id="fresh-heading" className="font-serif text-lg font-semibold">
            Copy the credential for &ldquo;{fresh.name}&rdquo; now
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            This is the only time it is shown. Only a one-way hash is stored, so it cannot be shown again. If you lose it, revoke it and create another.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <code data-testid="new-secret" className="min-w-0 flex-1 break-all rounded-md border bg-background px-3 py-2 font-mono text-[0.8125rem]">
              {fresh.secret}
            </code>
            <Button type="button" variant="outline" onClick={() => void copy(fresh.secret)}>
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Give it to your agent as the <code className="rounded bg-muted px-1 font-mono text-xs">BRAND_OS_CREDENTIAL</code> environment variable. Never paste it into a
            chat, a commit or a shared file.
          </p>
          <Button type="button" variant="ghost" size="sm" className="mt-3" onClick={() => setFresh(null)}>
            I have saved it
          </Button>
        </section>
      ) : null}

      <section aria-labelledby="create-heading">
        <h2 id="create-heading" className="font-serif text-xl font-semibold">
          New credential
        </h2>
        <p className="mt-1 mb-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          A credential lets a program you run, such as Claude Code, act on your account. It can only ever reach your own data, and only what its scopes allow. It
          cannot publish, approve or sign in.
        </p>
        <form onSubmit={create} className="grid max-w-2xl gap-4" noValidate>
          <Field label="Name" htmlFor="cred-name" hint="Where it will be used, for example Claude Code on my laptop." error={error?.fields.name}>
            <Input id="cred-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
          </Field>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">What it may do</legend>
            {AGENT_SCOPES.map((scope) => (
              <label key={scope} className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 has-[:checked]:border-primary/60">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => toggle(scope)}
                  className="mt-1 size-4 accent-[var(--primary)]"
                  aria-describedby={`scope-${scope}-hint`}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{SCOPE_LABELS[scope].label}</span>
                  <span id={`scope-${scope}-hint`} className="block text-xs leading-relaxed text-muted-foreground">
                    {SCOPE_LABELS[scope].hint}
                  </span>
                </span>
              </label>
            ))}
            {error?.fields.scopes ? (
              <p role="alert" className="text-xs font-medium text-destructive">
                {error.fields.scopes}
              </p>
            ) : null}
          </fieldset>
          {error && Object.keys(error.fields).length === 0 ? <FormNotice tone="error">{error.message}</FormNotice> : null}
          <div>
            <Button type="submit" disabled={busy}>
              <KeyRound aria-hidden />
              {busy ? 'Creating' : 'Create credential'}
            </Button>
          </div>
        </form>
      </section>

      <section aria-labelledby="list-heading">
        <h2 id="list-heading" className="font-serif text-xl font-semibold">
          Your credentials
        </h2>
        {active.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed bg-card/60 p-5 text-sm text-muted-foreground">
            You have not created one yet. Nothing outside this app can reach your account until you do.
          </p>
        ) : (
          <ul className="mt-4 grid gap-3">
            {active.map((c) => (
              <li key={c.id} className="rounded-xl border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{c.name}</p>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">{c.prefix}&hellip;</p>
                  </div>
                  {confirming === c.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-muted-foreground">Agents using it stop working at once.</span>
                      <Button type="button" variant="destructive" size="sm" onClick={() => void revoke(c.id)}>
                        Revoke
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(c.id)} aria-label={`Revoke ${c.name}`}>
                      Revoke
                    </Button>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {c.scopes.map((s) => (
                    <Badge key={s} variant="secondary">
                      {SCOPE_LABELS[s].label}
                    </Badge>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Created {formatWhen(c.createdAt)} &middot; {c.lastUsedAt ? `last used ${formatWhen(c.lastUsedAt)}` : 'never used'}
                </p>
              </li>
            ))}
          </ul>
        )}
        {revoked.length > 0 ? (
          <details className="mt-6">
            <summary className="cursor-pointer text-sm text-muted-foreground">Revoked ({revoked.length})</summary>
            <ul className="mt-3 grid gap-2">
              {revoked.map((c) => (
                <li key={c.id} className="rounded-lg border border-dashed bg-card/60 p-3 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{c.name}</span> <span className="font-mono text-xs">{c.prefix}&hellip;</span> &middot; revoked{' '}
                  {formatWhen(c.revokedAt)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
    </div>
  );
}

'use client';

import { Cloud, Cpu, HardDrive, Plug, Plus, Terminal, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FormNotice, Input, Select } from '@/components/ui/field';
import {
  ANTHROPIC_SUGGESTED_MODELS,
  KIND_INFO,
  LOCAL_PRESETS,
  PROTOCOL_LABELS,
  TRUST_LABELS,
  type ProviderDTO,
  type ProviderKind,
  type Protocol,
} from '@/lib/ai';
import { api } from '@/lib/api-client';
import { formatWhen } from '@/lib/format';
import { cn } from '@/lib/utils';

type Mode = 'local' | 'hosted';

const KIND_ICON: Record<ProviderKind, typeof Cpu> = { local: HardDrive, api_key: Cloud, claude_code_handoff: Plug, local_cli_agent: Terminal };

interface TestState {
  busy?: boolean;
  ok?: boolean;
  message?: string;
}

function NotesList({ kind }: { kind: ProviderKind }) {
  return (
    <ul className="grid gap-1.5 text-sm leading-relaxed text-muted-foreground">
      {KIND_INFO[kind].notes.map((note) => (
        <li key={note} className="flex gap-2">
          <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60" />
          <span>{note}</span>
        </li>
      ))}
    </ul>
  );
}

function TrustBadge({ trust }: { trust: ProviderDTO['trust'] }) {
  return (
    <Badge variant="outline" className={cn(trust === 'local' ? 'border-success/50 text-success' : 'border-warning/60 text-warning')}>
      {TRUST_LABELS[trust]}
    </Badge>
  );
}

/** Settings > AI: add, check and remove the providers that run AI tasks. Everything works with none. */
export function ProvidersManager({ initial, mode }: { initial: ProviderDTO[]; mode: Mode }) {
  const [providers, setProviders] = useState(initial);
  const [adding, setAdding] = useState<ProviderKind | null>(initial.length === 0 ? 'local' : null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const replace = (next: ProviderDTO) => setProviders((current) => current.map((p) => (p.id === next.id ? next : p)));

  async function refresh() {
    const result = await api<{ providers: ProviderDTO[] }>('/api/ai/providers');
    if (result.ok) setProviders(result.data.providers);
  }

  async function test(id: string) {
    setTests((t) => ({ ...t, [id]: { busy: true } }));
    const result = await api<{ ok: boolean; message: string; latencyMs: number | null; sample: string | null }>(`/api/ai/providers/${id}/test`, { method: 'POST', json: {} });
    if (!result.ok) {
      setTests((t) => ({ ...t, [id]: { ok: false, message: result.network ? 'Could not reach the app server.' : result.error } }));
    } else {
      const { ok, message, latencyMs, sample } = result.data;
      setTests((t) => ({
        ...t,
        [id]: { ok, message: ok ? `Answered in ${latencyMs} ms${sample ? `: “${sample}”` : ''}.` : message },
      }));
    }
    void refresh();
  }

  async function makeDefault(id: string) {
    const result = await api<ProviderDTO>(`/api/ai/providers/${id}/default`, { method: 'POST', json: {} });
    if (result.ok) void refresh();
    else setProblem(result.error);
  }

  async function toggle(p: ProviderDTO) {
    const result = await api<ProviderDTO>(`/api/ai/providers/${p.id}`, { method: 'PATCH', json: { enabled: !p.enabled } });
    if (result.ok) replace(result.data);
    else setProblem(result.error);
  }

  async function remove(id: string) {
    const result = await api(`/api/ai/providers/${id}`, { method: 'DELETE' });
    setRemoving(null);
    if (result.ok) {
      setProviders((current) => current.filter((p) => p.id !== id));
      void refresh();
    } else setProblem(result.error);
  }

  const kinds: ProviderKind[] = ['local', 'api_key', 'claude_code_handoff', 'local_cli_agent'];
  const ready = providers.filter((p) => p.ready);

  return (
    <div className="grid gap-10">
      <section aria-labelledby="state-heading" className="rounded-xl border bg-card p-4 sm:p-5">
        <h2 id="state-heading" className="font-serif text-lg font-semibold">
          {ready.length > 0 ? 'AI is on' : 'AI is off, and that is fine'}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {ready.length > 0
            ? 'AI buttons appear in the article studio. Nothing is ever applied without your click, and results never publish anything.'
            : 'Writing, importing, history and every other feature work without a provider. Add one below to get AI actions in the article studio: improve a selection, tighten, check accuracy, suggest titles.'}
        </p>
      </section>

      {problem ? <FormNotice tone="error">{problem}</FormNotice> : null}

      {providers.length > 0 ? (
        <section aria-labelledby="providers-heading">
          <h2 id="providers-heading" className="font-serif text-xl font-semibold">
            Your providers
          </h2>
          <ul className="mt-4 grid gap-3">
            {providers.map((p) => {
              const Icon = KIND_ICON[p.kind];
              const t = tests[p.id];
              return (
                <li key={p.id} className="rounded-xl border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                        <Icon className="size-[1.125rem]" />
                      </span>
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 font-medium">
                          {p.name}
                          {p.isDefault ? <Badge variant="secondary">Default</Badge> : null}
                        </p>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {KIND_INFO[p.kind].label}
                          {p.protocol ? ` · ${PROTOCOL_LABELS[p.protocol]}` : ''}
                          {p.model ? ` · ${p.model}` : ''}
                        </p>
                        {p.baseUrl ? <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{p.baseUrl}</p> : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <TrustBadge trust={p.trust} />
                      <Badge variant="outline" className={cn(p.ready ? 'border-success/50 text-success' : 'border-input text-muted-foreground')}>
                        {p.ready ? 'Ready' : (p.notReadyReason ?? 'Not ready')}
                      </Badge>
                    </div>
                  </div>

                  <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                    {p.hasKey ? (
                      <div>
                        <dt className="inline">Key: </dt>
                        <dd className="inline">saved, ends in {p.keyLast4}</dd>
                      </div>
                    ) : null}
                    {p.monthlyTokenCap ? (
                      <div>
                        <dt className="inline">This month: </dt>
                        <dd className="inline">
                          {p.usedThisMonth.toLocaleString('en')} of {p.monthlyTokenCap.toLocaleString('en')} estimated tokens
                        </dd>
                      </div>
                    ) : p.kind === 'local' || p.kind === 'api_key' ? (
                      <div>
                        <dt className="inline">This month: </dt>
                        <dd className="inline">{p.usedThisMonth.toLocaleString('en')} estimated tokens, no cap</dd>
                      </div>
                    ) : null}
                    {p.lastTest ? (
                      <div className="sm:col-span-2">
                        <dt className="inline">Last test: </dt>
                        <dd className="inline">
                          {p.lastTest.ok ? 'passed' : `failed, ${p.lastTest.message}`} ({formatWhen(p.lastTest.at)})
                        </dd>
                      </div>
                    ) : null}
                  </dl>

                  {t?.message ? (
                    <div className="mt-3">
                      <FormNotice tone={t.ok ? 'success' : 'error'}>{t.message}</FormNotice>
                    </div>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {p.kind === 'local' || p.kind === 'api_key' ? (
                      <Button type="button" size="sm" variant="outline" disabled={!p.ready || t?.busy} onClick={() => void test(p.id)}>
                        {t?.busy ? 'Testing' : 'Test connection'}
                      </Button>
                    ) : null}
                    {!p.isDefault && p.ready ? (
                      <Button type="button" size="sm" variant="ghost" onClick={() => void makeDefault(p.id)}>
                        Make default
                      </Button>
                    ) : null}
                    <Button type="button" size="sm" variant="ghost" onClick={() => void toggle(p)}>
                      {p.enabled ? 'Turn off' : 'Turn on'}
                    </Button>
                    {p.kind !== 'claude_code_handoff' ? (
                      <Button type="button" size="sm" variant="ghost" aria-expanded={editing === p.id} onClick={() => setEditing(editing === p.id ? null : p.id)}>
                        Edit
                      </Button>
                    ) : null}
                    {removing === p.id ? (
                      <span className="ml-auto flex flex-wrap items-center gap-2">
                        <span className="text-sm text-muted-foreground">Remove it and its saved key?</span>
                        <Button type="button" size="sm" variant="destructive" onClick={() => void remove(p.id)}>
                          Remove
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <Button type="button" size="sm" variant="ghost" className="ml-auto" aria-label={`Remove ${p.name}`} onClick={() => setRemoving(p.id)}>
                        <Trash2 aria-hidden />
                        Remove
                      </Button>
                    )}
                  </div>

                  {editing === p.id ? (
                    <EditForm
                      provider={p}
                      onSaved={(next) => {
                        replace(next);
                        setEditing(null);
                      }}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="add-heading">
        <h2 id="add-heading" className="font-serif text-xl font-semibold">
          Add a provider
        </h2>
        <div role="group" aria-label="Provider type" className="mt-4 grid gap-2 sm:grid-cols-2">
          {kinds.map((kind) => {
            const info = KIND_INFO[kind];
            const Icon = KIND_ICON[kind];
            const hostedBlocked = mode === 'hosted' && kind === 'local';
            const disabled = !info.available || hostedBlocked;
            return (
              <button
                key={kind}
                type="button"
                disabled={disabled}
                aria-pressed={adding === kind}
                onClick={() => setAdding(adding === kind ? null : kind)}
                className={cn(
                  'flex items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                  disabled ? 'cursor-not-allowed border-dashed bg-card/60 opacity-70' : 'bg-card hover:bg-accent',
                  adding === kind && 'border-primary/70 ring-1 ring-primary/40',
                )}
              >
                <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <Icon className="size-[1.125rem]" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{info.label}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{info.summary}</span>
                  {!info.available ? <span className="mt-1.5 block text-xs font-medium text-muted-foreground">Not built yet. Reserved for later.</span> : null}
                  {hostedBlocked ? <span className="mt-1.5 block text-xs font-medium text-muted-foreground">Not available on a hosted server.</span> : null}
                </span>
              </button>
            );
          })}
        </div>

        {adding ? (
          <div className="mt-5 grid gap-5 rounded-xl border bg-card p-4 sm:p-5 lg:grid-cols-[1fr_20rem]">
            <AddForm
              key={adding}
              kind={adding}
              onCreated={(created) => {
                setProviders((current) => [...current, created]);
                setAdding(null);
                void refresh();
              }}
            />
            <aside aria-label="What to know about this provider type" className="rounded-lg bg-muted/50 p-4">
              <h3 className="mb-2 text-sm font-semibold">What to know</h3>
              <NotesList kind={adding} />
            </aside>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Notice({ error }: { error: { message: string; fields: Record<string, string> } | null }) {
  if (!error || Object.keys(error.fields).length > 0) return null;
  return <FormNotice tone="error">{error.message}</FormNotice>;
}

function AddForm({ kind, onCreated }: { kind: ProviderKind; onCreated(provider: ProviderDTO): void }) {
  const [preset, setPreset] = useState<(typeof LOCAL_PRESETS)[number]['id']>('ollama');
  const [protocol, setProtocol] = useState<Protocol>('anthropic');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState<string>(LOCAL_PRESETS[0].baseUrl);
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fields: Record<string, string> } | null>(null);

  const presetInfo = LOCAL_PRESETS.find((p) => p.id === preset) ?? LOCAL_PRESETS[0];

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const capNumber = cap.trim() === '' ? null : Number(cap.replace(/[,_\s]/g, ''));
    const defaultName = kind === 'local' ? presetInfo.label : kind === 'claude_code_handoff' ? 'Claude Code' : protocol === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible';
    const body =
      kind === 'local'
        ? { kind, name: name.trim() || defaultName, baseUrl, model, monthlyTokenCap: capNumber }
        : kind === 'api_key'
          ? { kind, protocol, name: name.trim() || defaultName, baseUrl: protocol === 'openai_compatible' ? baseUrl : null, model, apiKey, workspaceId: workspaceId || null, monthlyTokenCap: capNumber }
          : { kind, name: name.trim() || defaultName };
    const result = await api<ProviderDTO>('/api/ai/providers', { method: 'POST', json: body });
    setBusy(false);
    if (!result.ok) {
      setError({ message: result.network ? 'Could not reach the server.' : result.error, fields: result.fields });
      return;
    }
    setApiKey('');
    onCreated(result.data);
  }

  const f = error?.fields ?? {};
  const capField = (
    <Field label="Monthly soft cap (optional)" htmlFor="add-cap" hint="Estimated tokens per calendar month. When it is reached new tasks are blocked with a clear message until the month ends or you raise it." error={f.monthlyTokenCap}>
      <Input id="add-cap" inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="No cap" />
    </Field>
  );

  return (
    <form onSubmit={submit} className="grid min-w-0 content-start gap-4" noValidate>
      {kind === 'local' ? (
        <>
          <Field label="Server" htmlFor="add-preset">
            <Select
              id="add-preset"
              value={preset}
              onChange={(e) => {
                const next = LOCAL_PRESETS.find((p) => p.id === e.target.value) ?? LOCAL_PRESETS[0];
                setPreset(next.id);
                setBaseUrl(next.baseUrl);
              }}
            >
              {LOCAL_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Address" htmlFor="add-base" hint="The OpenAI-compatible address, ending in /v1." error={f.baseUrl}>
            <Input id="add-base" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Model" htmlFor="add-model" hint={`Use ${presetInfo.modelHint}.`} error={f.model}>
            <Input id="add-model" value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          {capField}
        </>
      ) : null}

      {kind === 'api_key' ? (
        <>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Service</legend>
            <div className="inline-flex w-fit overflow-hidden rounded-md border">
              {(['anthropic', 'openai_compatible'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={protocol === p}
                  onClick={() => setProtocol(p)}
                  className={cn('h-9 px-3 text-sm font-medium transition-colors', protocol === p ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-accent hover:text-foreground')}
                >
                  {PROTOCOL_LABELS[p]}
                </button>
              ))}
            </div>
            {f.protocol ? <p className="text-xs font-medium text-destructive">{f.protocol}</p> : null}
          </fieldset>
          {protocol === 'openai_compatible' ? (
            <Field label="Address" htmlFor="add-base" hint={'The service’s OpenAI-compatible address, ending in /v1. On a hosted server it must be https.'} error={f.baseUrl}>
              <Input id="add-base" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.test/v1" autoComplete="off" spellCheck={false} />
            </Field>
          ) : null}
          <Field
            label="Model"
            htmlFor="add-model"
            hint={protocol === 'anthropic' ? `Free text. Suggested: ${ANTHROPIC_SUGGESTED_MODELS.editing} for editing, ${ANTHROPIC_SUGGESTED_MODELS.cheap} for cheap tasks. Check the provider’s current model list.` : 'The model name the service expects.'}
            error={f.model}
          >
            <Input id="add-model" list={protocol === 'anthropic' ? 'anthropic-models' : undefined} value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" spellCheck={false} />
            {protocol === 'anthropic' ? (
              <datalist id="anthropic-models">
                <option value={ANTHROPIC_SUGGESTED_MODELS.editing} />
                <option value={ANTHROPIC_SUGGESTED_MODELS.cheap} />
              </datalist>
            ) : null}
          </Field>
          <Field label="API key" htmlFor="add-key" hint="Encrypted here. You will only ever see its last four characters again." error={f.apiKey}>
            <Input id="add-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          {protocol === 'anthropic' ? (
            <Field label="Workspace id (optional)" htmlFor="add-workspace" hint="Only needed if your key spans several workspaces.">
              <Input id="add-workspace" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          ) : null}
          {capField}
        </>
      ) : null}

      {kind === 'claude_code_handoff' ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Tasks you start in the studio wait in your inbox. In Claude Code, with the Brand OS server connected, ask it to list your AI tasks and complete one. You need an agent credential for that: create one under Agent access.
        </p>
      ) : null}

      <Field label="Name (optional)" htmlFor="add-name" error={f.name}>
        <Input id="add-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Shown in the studio" />
      </Field>
      <Notice error={error} />
      <div>
        <Button type="submit" disabled={busy}>
          <Plus aria-hidden />
          {busy ? 'Adding' : 'Add provider'}
        </Button>
      </div>
    </form>
  );
}

function EditForm({ provider, onSaved }: { provider: ProviderDTO; onSaved(provider: ProviderDTO): void }) {
  const [name, setName] = useState(provider.name);
  const [model, setModel] = useState(provider.model ?? '');
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [cap, setCap] = useState(provider.monthlyTokenCap ? String(provider.monthlyTokenCap) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fields: Record<string, string> } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { name, model, monthlyTokenCap: cap.trim() === '' ? null : Number(cap.replace(/[,_\s]/g, '')) };
    if (provider.protocol === 'openai_compatible') body.baseUrl = baseUrl;
    if (apiKey) body.apiKey = apiKey;
    const result = await api<ProviderDTO>(`/api/ai/providers/${provider.id}`, { method: 'PATCH', json: body });
    setBusy(false);
    if (!result.ok) {
      setError({ message: result.network ? 'Could not reach the server.' : result.error, fields: result.fields });
      return;
    }
    setApiKey('');
    onSaved(result.data);
  }
  const f = error?.fields ?? {};
  const row = (children: ReactNode) => <div className="grid gap-4 sm:grid-cols-2">{children}</div>;

  return (
    <form onSubmit={submit} className="mt-4 grid gap-4 border-t pt-4" noValidate>
      {row(
        <>
          <Field label="Name" htmlFor={`edit-name-${provider.id}`} error={f.name}>
            <Input id={`edit-name-${provider.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Field label="Model" htmlFor={`edit-model-${provider.id}`} error={f.model}>
            <Input id={`edit-model-${provider.id}`} value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
        </>,
      )}
      {provider.protocol === 'openai_compatible' ? (
        <Field label="Address" htmlFor={`edit-base-${provider.id}`} error={f.baseUrl}>
          <Input id={`edit-base-${provider.id}`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
      ) : null}
      {provider.kind === 'api_key' ? (
        <Field label="Replace the API key" htmlFor={`edit-key-${provider.id}`} hint="Leave empty to keep the saved key." error={f.apiKey}>
          <Input id={`edit-key-${provider.id}`} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
      ) : null}
      <Field label="Monthly soft cap (estimated tokens)" htmlFor={`edit-cap-${provider.id}`} error={f.monthlyTokenCap}>
        <Input id={`edit-cap-${provider.id}`} inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="No cap" />
      </Field>
      <Notice error={error} />
      <div>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

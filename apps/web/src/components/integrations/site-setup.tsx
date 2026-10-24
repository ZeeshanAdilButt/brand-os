'use client';

import { Plus, Save, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormNotice, Input, Select } from '@/components/ui/field';
import { api } from '@/lib/api-client';
import {
  DATE_FORMATS,
  DATE_FORMAT_LABELS,
  SITE_FIELD_KEYS,
  SITE_PRESETS,
  SITE_PRESET_LABELS,
  defaultPathTemplate,
  presetMapping,
  renderSiteFile,
  type SiteMapping,
  type SitePreset,
  type SiteSettingsDTO,
} from '@/lib/site-export';
import { Block } from './parts';

const FIELD_LABELS: Record<(typeof SITE_FIELD_KEYS)[number], string> = {
  title: 'Title',
  description: 'Description',
  date: 'Date',
  tags: 'Tags',
  canonical: 'Canonical URL',
  cover: 'Cover image',
  slug: 'Slug',
  series: 'Series',
  draft: 'Draft flag (written as false)',
};

const SAMPLE = {
  title: 'Why the write path stalls',
  description: 'A short look at write stalls.',
  tags: ['go', 'databases'],
  canonicalUrl: 'https://example-blog.dev/posts/write-path',
  coverImageUrl: null,
  series: null,
  bodyMarkdown: 'The write path stalls when the log fills.\n',
};

/**
 * The personal site: where it lives, which repository a pull request goes to, and how a file is laid out. Markdown
 * export needs only these settings. Opening a pull request also needs a fine-grained GitHub token for that one
 * repository. The example below is built from the settings as you edit them.
 */
export function SiteSetup({ initial, onSaved }: { initial: SiteSettingsDTO; onSaved?(settings: SiteSettingsDTO): void }) {
  const [settings, setSettings] = useState(initial);
  const [saved, setSaved] = useState(initial.updatedAt !== null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const change = (patch: Partial<SiteSettingsDTO>) => {
    setSettings((s) => ({ ...s, ...patch }));
    setSaved(false);
  };
  const changeMapping = (patch: Partial<SiteMapping>) => change({ mapping: { ...settings.mapping, ...patch } });

  function choosePreset(preset: SitePreset) {
    change({ mapping: presetMapping(preset), pathTemplate: defaultPathTemplate(preset) });
  }

  const example = useMemo(() => {
    try {
      return renderSiteFile(SAMPLE, settings.mapping, '2026-10-21T09:30:00Z', 'write-path').frontMatter;
    } catch {
      return 'The mapping cannot be drawn yet.';
    }
  }, [settings.mapping]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    setErrors({});
    const result = await api<SiteSettingsDTO>('/api/site-settings', {
      method: 'PUT',
      json: {
        siteUrl: settings.siteUrl || null,
        repo: settings.repo || null,
        baseBranch: settings.baseBranch,
        pathTemplate: settings.pathTemplate,
        preset: settings.mapping.preset,
        mapping: settings.mapping,
      },
    });
    setBusy(false);
    if (result.ok) {
      setSettings(result.data);
      setSaved(true);
      onSaved?.(result.data);
      setNotice({ tone: 'success', text: 'Settings saved. Drafts you already built keep their old layout until you rebuild them.' });
    } else {
      setErrors(result.fields);
      setNotice({ tone: 'error', text: result.network ? 'Could not reach the app server.' : result.error });
    }
  }

  return (
    <div className="grid gap-6">
      <form onSubmit={(e) => void save(e)} className="grid gap-5" noValidate>
        <Block title="Where your site lives">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Site address" htmlFor="site-url" hint="Your public address. The canonical page must be on this host." error={errors.siteUrl}>
              <Input id="site-url" value={settings.siteUrl ?? ''} onChange={(e) => change({ siteUrl: e.target.value })} placeholder="https://example-blog.dev" inputMode="url" />
            </Field>
            <Field label="Repository" htmlFor="site-repo" hint="owner/name of the one repository a pull request goes to. Leave empty to use Markdown export only." error={errors.repo}>
              <Input id="site-repo" value={settings.repo ?? ''} onChange={(e) => change({ repo: e.target.value })} placeholder="example-owner/example-site" spellCheck={false} />
            </Field>
            <Field label="Base branch" htmlFor="site-base" hint="The branch the pull request is opened against. The app never writes to it." error={errors.baseBranch}>
              <Input id="site-base" value={settings.baseBranch} onChange={(e) => change({ baseBranch: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="File path" htmlFor="site-path" hint="Use {slug}, {year}, {month}, {day} and {ext}." error={errors.pathTemplate}>
              <Input id="site-path" value={settings.pathTemplate} onChange={(e) => change({ pathTemplate: e.target.value })} spellCheck={false} className="font-mono" />
            </Field>
          </div>
        </Block>

        <Block title="How a file is laid out">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Preset" htmlFor="site-preset" hint="Resets the names below to a starting point.">
              <Select id="site-preset" value={settings.mapping.preset} onChange={(e) => choosePreset(e.target.value as SitePreset)}>
                {SITE_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {SITE_PRESET_LABELS[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date format" htmlFor="site-date">
              <Select id="site-date" value={settings.mapping.dateFormat} onChange={(e) => changeMapping({ dateFormat: e.target.value as SiteMapping['dateFormat'] })}>
                {DATE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {DATE_FORMAT_LABELS[f]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Extension" htmlFor="site-ext">
              <Select id="site-ext" value={settings.mapping.extension} onChange={(e) => changeMapping({ extension: e.target.value as 'md' | 'mdx' })}>
                <option value="md">.md</option>
                <option value="mdx">.mdx</option>
              </Select>
            </Field>
          </div>
          <details className="rounded-lg border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Front matter key names and fixed keys</summary>
            <div className="grid gap-4 border-t p-3">
              <div className="grid gap-3 sm:grid-cols-3">
                {SITE_FIELD_KEYS.map((key) => (
                  <Field key={key} label={FIELD_LABELS[key]} htmlFor={`site-field-${key}`}>
                    <Input
                      id={`site-field-${key}`}
                      value={settings.mapping.fields[key]}
                      onChange={(e) => changeMapping({ fields: { ...settings.mapping.fields, [key]: e.target.value } })}
                      placeholder="(left out)"
                      spellCheck={false}
                      className="font-mono"
                    />
                  </Field>
                ))}
              </div>
              {errors.mapping ? <p role="alert" className="text-xs font-medium text-danger">{errors.mapping}</p> : null}
              <div className="grid gap-2">
                <p className="text-sm font-medium">Fixed keys added to every file</p>
                {settings.mapping.fixed.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input aria-label={`Fixed key ${i + 1} name`} value={row.key} onChange={(e) => changeMapping({ fixed: settings.mapping.fixed.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)) })} className="font-mono" placeholder="layout" />
                    <Input aria-label={`Fixed key ${i + 1} value`} value={String(row.value)} onChange={(e) => changeMapping({ fixed: settings.mapping.fixed.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)) })} placeholder="post" />
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove fixed key ${i + 1}`} onClick={() => changeMapping({ fixed: settings.mapping.fixed.filter((_, j) => j !== i) })}>
                      <X aria-hidden />
                    </Button>
                  </div>
                ))}
                <div>
                  <Button type="button" variant="outline" size="sm" onClick={() => changeMapping({ fixed: [...settings.mapping.fixed, { key: '', value: '' }] })} disabled={settings.mapping.fixed.length >= 10}>
                    <Plus aria-hidden />
                    Add a key
                  </Button>
                </div>
              </div>
            </div>
          </details>
          <div>
            <p className="mb-1 text-sm font-medium">Example front matter</p>
            <pre aria-label="Example front matter" className="overflow-x-auto rounded-lg bg-code-background p-3 font-mono text-xs leading-5">
              {example}
            </pre>
          </div>
        </Block>

        {notice ? <FormNotice tone={notice.tone}>{notice.text}</FormNotice> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy || saved}>
            <Save aria-hidden />
            {busy ? 'Saving' : saved ? 'Saved' : 'Save site settings'}
          </Button>
          <p className="text-xs text-muted-foreground">Saving sends nothing anywhere.</p>
        </div>
      </form>
    </div>
  );
}

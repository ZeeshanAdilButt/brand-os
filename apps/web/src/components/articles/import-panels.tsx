'use client';

import { AlertTriangle, CheckCircle2, FileUp, FolderOpen, Globe, Info } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type ReactNode } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, FormNotice, Input } from '@/components/ui/field';
import type { ArticleDTO } from '@/lib/articles';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface ImportResultDTO {
  article: ArticleDTO;
  warnings: string[];
  notes: string[];
}

function Card({ icon, title, intro, children, id }: { icon: ReactNode; title: string; intro: string; children: ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="rounded-xl border bg-card p-4 shadow-xs sm:p-5">
      <div className="flex items-start gap-3">
        <div aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background text-link">
          {icon}
        </div>
        <div className="min-w-0">
          <h2 id={id} className="font-serif text-lg font-semibold">
            {title}
          </h2>
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{intro}</p>
        </div>
      </div>
      <div className="mt-4 grid gap-3">{children}</div>
    </section>
  );
}

/** What an import did and what to check, with a way into the article. */
function ImportResult({ result }: { result: ImportResultDTO }) {
  return (
    <div className="grid gap-3 rounded-lg border border-success/40 bg-success/5 p-3 text-sm" role="status">
      <p className="flex items-start gap-2 font-medium">
        <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
        <span className="min-w-0 break-words">Imported &ldquo;{result.article.title || 'Untitled'}&rdquo; as a draft.</span>
      </p>
      {result.warnings.length > 0 ? (
        <ul className="grid gap-1.5">
          {result.warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1.5">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              <span className="min-w-0 break-words">{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {result.notes.length > 0 ? (
        <ul className="grid gap-1 text-muted-foreground">
          {result.notes.map((note) => (
            <li key={note} className="flex items-start gap-2">
              <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">{note}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Link href={`/articles/${result.article.id}`} className={buttonVariants({ size: 'sm' })}>
          Open in the studio
        </Link>
        <Link href={`/articles/${result.article.id}/read`} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
          Reading view
        </Link>
      </div>
    </div>
  );
}

export function ImportFile() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResultDTO | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) {
      setError('Choose a file first.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    const form = new FormData();
    form.set('file', file);
    const response = await api<ImportResultDTO>('/api/articles/import/file', { method: 'POST', body: form });
    setBusy(false);
    if (response.ok) {
      setResult(response.data);
      if (input.current) input.current.value = '';
    } else setError(response.network ? 'Could not reach the server.' : (response.fields.file ?? response.error));
  }

  return (
    <Card id="import-file" icon={<FileUp className="size-4" />} title="From a file" intro="A Markdown file: .md, .mdx, .markdown or .txt, up to 1 MB. Front matter becomes the title, description, tags and canonical address.">
      <form onSubmit={submit} className="grid gap-3" noValidate>
        <Field label="File" htmlFor="import-file-input" hint="MDX components and imports are kept as text, and you are told which ones.">
          <Input id="import-file-input" ref={input} type="file" accept=".md,.mdx,.markdown,.txt,text/markdown,text/plain" className="h-auto cursor-pointer py-2 file:mr-3 file:cursor-pointer" />
        </Field>
        {error ? <FormNotice tone="error">{error}</FormNotice> : null}
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Importing' : 'Import file'}
          </Button>
        </div>
      </form>
      {result ? <ImportResult result={result} /> : null}
    </Card>
  );
}

export function ImportUrl() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResultDTO | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    const response = await api<ImportResultDTO>('/api/articles/import/url', { method: 'POST', json: { url } });
    setBusy(false);
    if (response.ok) {
      setResult(response.data);
      setUrl('');
    } else setError(response.network ? 'Could not reach the server.' : (response.fields.url ?? response.error));
  }

  return (
    <Card
      id="import-url"
      icon={<Globe className="size-4" />}
      title="From a web page"
      intro="Paste the address of a public article. The main text is kept as Markdown with its code blocks, tables, links and images, and the page address becomes the canonical URL."
    >
      <form onSubmit={submit} className="grid gap-3" noValidate>
        <Field
          label="Web address"
          htmlFor="import-url-input"
          hint="Only public http and https pages. Addresses on this computer or a private network are refused, and no cookies or sign-in details are sent."
        >
          <Input
            id="import-url-input"
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example-blog.dev/posts/my-article"
            required
            maxLength={2000}
            aria-invalid={error ? true : undefined}
          />
        </Field>
        {error ? <FormNotice tone="error">{error}</FormNotice> : null}
        <div>
          <Button type="submit" disabled={busy || url.trim() === ''}>
            {busy ? 'Fetching' : 'Import page'}
          </Button>
        </div>
      </form>
      {result ? <ImportResult result={result} /> : null}
    </Card>
  );
}

export interface FolderFileDTO {
  path: string;
  size: number;
  modifiedAt: string;
  importedAs: { id: string; title: string } | null;
}

export interface FolderStatusDTO {
  available: boolean;
  reason: string | null;
  folder: string | null;
  files: FolderFileDTO[];
  skipped: { links: number; unreadable: number; truncated: boolean };
  problem: string | null;
}

export function ImportFolder({ initial }: { initial: FolderStatusDTO }) {
  const [status, setStatus] = useState(initial);
  const [path, setPath] = useState(initial.folder ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ImportResultDTO>>({});

  if (!status.available) {
    return (
      <Card id="import-folder" icon={<FolderOpen className="size-4" />} title="From a folder" intro="A folder of Markdown files on this computer.">
        <p className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          {status.reason}
        </p>
      </Card>
    );
  }

  async function saveFolder(event: React.FormEvent) {
    event.preventDefault();
    setBusy('folder');
    setError(null);
    const response = await api<FolderStatusDTO>('/api/articles/import/folder', { method: 'PUT', json: { path } });
    setBusy(null);
    if (response.ok) {
      setStatus(response.data);
      setPath(response.data.folder ?? '');
    } else setError(response.network ? 'Could not reach the server.' : (response.fields.path ?? response.error));
  }

  async function importOne(file: FolderFileDTO) {
    setBusy(file.path);
    setError(null);
    const response = await api<ImportResultDTO>('/api/articles/import/folder', { method: 'POST', json: { path: file.path } });
    setBusy(null);
    if (response.ok) {
      setResults((prev) => ({ ...prev, [file.path]: response.data }));
      setStatus((prev) => ({
        ...prev,
        files: prev.files.map((f) => (f.path === file.path ? { ...f, importedAs: { id: response.data.article.id, title: response.data.article.title } } : f)),
      }));
    } else setError(response.network ? 'Could not reach the server.' : (response.fields.path ?? response.error));
  }

  return (
    <Card
      id="import-folder"
      icon={<FolderOpen className="size-4" />}
      title="From a folder"
      intro="Point at a folder of .md and .mdx files on this computer, then import the ones you want, one at a time. The folder is only ever read, never changed."
    >
      <form onSubmit={saveFolder} className="grid gap-3" noValidate>
        <Field label="Folder path" htmlFor="import-folder-path" hint="The full path, for example the content folder of your site. Links that lead outside this folder are skipped.">
          <Input
            id="import-folder-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="C:\sites\my-blog\content"
            spellCheck={false}
            autoCapitalize="none"
            maxLength={1000}
            className="font-mono"
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy === 'folder'} variant={status.folder ? 'outline' : 'default'}>
            {busy === 'folder' ? 'Checking' : status.folder ? 'Change folder' : 'Use this folder'}
          </Button>
          {status.folder ? (
            <Button
              type="button"
              variant="ghost"
              onClick={async () => {
                setPath('');
                const response = await api<FolderStatusDTO>('/api/articles/import/folder', { method: 'PUT', json: { path: '' } });
                if (response.ok) setStatus(response.data);
              }}
            >
              Forget it
            </Button>
          ) : null}
        </div>
      </form>

      {error ? <FormNotice tone="error">{error}</FormNotice> : null}
      {status.problem ? <FormNotice tone="error">{status.problem}</FormNotice> : null}

      {status.folder && !status.problem ? (
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {status.files.length === 0 ? 'No Markdown files found in this folder.' : `${status.files.length}${status.skipped.truncated ? '+' : ''} Markdown ${status.files.length === 1 ? 'file' : 'files'}, newest first.`}
          </p>
          {status.skipped.links > 0 || status.skipped.unreadable > 0 || status.skipped.truncated ? (
            <p className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>
                {status.skipped.links > 0 ? `${status.skipped.links} ${status.skipped.links === 1 ? 'link was' : 'links were'} skipped because ${status.skipped.links === 1 ? 'it leads' : 'they lead'} outside the folder or ${status.skipped.links === 1 ? 'is' : 'are'} not a file. ` : ''}
                {status.skipped.unreadable > 0 ? `${status.skipped.unreadable} could not be read. ` : ''}
                {status.skipped.truncated ? 'Only the first 500 files are listed.' : ''}
              </span>
            </p>
          ) : null}
          <ul className="grid max-h-96 gap-1.5 overflow-y-auto pr-1">
            {status.files.map((file) => (
              <li key={file.path} className="rounded-lg border bg-background p-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="min-w-0 flex-1 basis-48 break-all font-mono text-xs sm:text-sm" title={file.path}>
                    {file.path}
                  </span>
                  <span className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(file.size < 10_240 ? 1 : 0)} KB</span>
                  {file.importedAs ? (
                    <Link href={`/articles/${file.importedAs.id}`} className="text-xs text-link underline underline-offset-2">
                      Imported: open
                    </Link>
                  ) : null}
                  <Button type="button" size="xs" variant={file.importedAs ? 'ghost' : 'outline'} disabled={busy !== null} onClick={() => void importOne(file)}>
                    {busy === file.path ? 'Importing' : file.importedAs ? 'Import again' : 'Import'}
                  </Button>
                </div>
                {results[file.path] ? <div className={cn('mt-2')}><ImportResult result={results[file.path]!} /></div> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

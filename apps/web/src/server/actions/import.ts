import { z } from 'zod';
import type { Article } from '../db/schema';
import { DocumentError, decodeText, extensionOf, IMPORT_EXTENSIONS, parseMarkdownDocument, type ParsedDocument } from '../import/document';
import { FolderError, listMarkdownFiles, readMarkdownFile, resolveContentFolder, type FolderFile } from '../import/folder';
import { extractArticle } from '../import/html';
import { fetchPage, mediaType, UrlImportError, type UrlImportDeps } from '../import/url';
import { createImportedArticle } from './articles';
import { ActionError, parseInput, type OwnerContext } from './owner';

/** The article an import created, and what the writer should know about how it went. */
export interface ImportResult {
  article: Article;
  warnings: string[];
  notes: string[];
}

function documentError(err: unknown): never {
  if (err instanceof DocumentError) throw new ActionError('invalid', err.message, { file: err.message });
  throw err;
}

async function saveParsed(
  owner: OwnerContext,
  parsed: ParsedDocument,
  source: { kind: 'file' | 'url' | 'folder'; ref: string },
): Promise<ImportResult> {
  const article = await createImportedArticle(owner, {
    title: parsed.title,
    description: parsed.description,
    tags: parsed.tags,
    canonicalUrl: parsed.canonicalUrl,
    bodyMarkdown: parsed.body,
    extraMetadata: parsed.extraMetadata,
    sourceKind: source.kind,
    sourceRef: source.ref,
  });
  return { article, warnings: parsed.warnings, notes: parsed.notes };
}

/** Import an uploaded .md, .mdx, .markdown or .txt file. */
export async function importFile(owner: OwnerContext, file: { filename: string; bytes: Uint8Array }): Promise<ImportResult> {
  const ext = extensionOf(file.filename);
  if (!(IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ActionError('invalid', 'Choose a .md, .mdx, .markdown or .txt file.', { file: 'Choose a .md, .mdx, .markdown or .txt file.' });
  }
  let parsed: ParsedDocument;
  try {
    parsed = parseMarkdownDocument(decodeText(file.bytes), file.filename);
  } catch (err) {
    return documentError(err);
  }
  return saveParsed(owner, parsed, { kind: 'file', ref: file.filename.split(/[\\/]/).pop() ?? file.filename });
}

const urlSchema = z.object({ url: z.string().trim().min(1, 'Enter a web address.').max(2000) });

function charsetOf(contentType: string): string {
  return /charset=["']?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8';
}

function decodeBody(body: Uint8Array, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType)).decode(body).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('utf-8').decode(body).replace(/^﻿/, '');
  }
}

/** Fetch a public web page (SSRF-checked, see import/url.ts) and import its main article as Markdown. */
export async function importUrl(owner: OwnerContext, input: unknown, deps: UrlImportDeps = {}): Promise<ImportResult> {
  const { url } = parseInput(urlSchema, input);
  let page;
  try {
    page = await fetchPage(url, deps);
  } catch (err) {
    if (err instanceof UrlImportError) throw new ActionError('invalid', err.message, { url: err.message });
    throw err;
  }
  const type = mediaType(page.contentType);
  const source = { kind: 'url' as const, ref: page.finalUrl.toString() };
  const text = decodeBody(page.body, page.contentType);

  if (type === 'text/markdown' || type === 'text/x-markdown' || type === 'text/plain') {
    const name = page.finalUrl.pathname.split('/').filter(Boolean).pop() ?? page.finalUrl.hostname;
    const parsed = parseMarkdownDocument(text, name);
    parsed.canonicalUrl ??= page.finalUrl.toString();
    return saveParsed(owner, parsed, source);
  }

  let extracted;
  try {
    extracted = await extractArticle(text, page.finalUrl);
  } catch (err) {
    if (err instanceof UrlImportError) throw new ActionError('invalid', err.message, { url: err.message });
    throw err;
  }
  const extra: Record<string, unknown> = { importedFrom: page.finalUrl.toString() };
  if (extracted.byline) extra.byline = extracted.byline;
  if (extracted.siteName) extra.site = extracted.siteName;
  if (extracted.publishedTime) extra.date = extracted.publishedTime;
  return saveParsed(
    owner,
    {
      title: extracted.title || page.finalUrl.hostname,
      description: '',
      tags: [],
      canonicalUrl: page.finalUrl.toString(),
      body: extracted.markdown,
      extraMetadata: extra,
      warnings: extracted.warnings,
      notes: [`Fetched ${page.finalUrl.hostname} and kept the main article.`],
    },
    source,
  );
}

/* Folder import: the owner's own computer, so local mode only. */

const FOLDER_LOCAL_ONLY = 'Folder import reads files on the computer that runs the app, so it is only available in local mode.';

function requireLocal(mode: 'local' | 'hosted'): void {
  if (mode !== 'local') throw new ActionError('invalid', FOLDER_LOCAL_ONLY);
}

function folderError(err: unknown): never {
  if (err instanceof FolderError) {
    throw new ActionError(err.code === 'not_found' ? 'not_found' : 'invalid', err.message, { path: err.message });
  }
  return documentError(err);
}

export interface FolderStatus {
  available: boolean;
  /** Why it is not available. */
  reason: string | null;
  folder: string | null;
  files: (FolderFile & { importedAs: { id: string; title: string } | null })[];
  skipped: { links: number; unreadable: number; truncated: boolean };
  problem: string | null;
}

export async function getFolderStatus(owner: OwnerContext, mode: 'local' | 'hosted'): Promise<FolderStatus> {
  const empty = { links: 0, unreadable: 0, truncated: false };
  if (mode !== 'local') {
    return { available: false, reason: FOLDER_LOCAL_ONLY, folder: null, files: [], skipped: empty, problem: null };
  }
  const { contentFolder } = await owner.data.studioSettings.get();
  if (!contentFolder) return { available: true, reason: null, folder: null, files: [], skipped: empty, problem: null };
  try {
    const listing = await listMarkdownFiles(contentFolder);
    const imported = await owner.data.articles.importedFrom(
      'folder',
      listing.files.map((f) => f.path),
    );
    const byRef = new Map(imported.map((i) => [i.sourceRef, { id: i.id, title: i.title }]));
    return {
      available: true,
      reason: null,
      folder: contentFolder,
      files: listing.files.map((f) => ({ ...f, importedAs: byRef.get(f.path) ?? null })),
      skipped: listing.skipped,
      problem: null,
    };
  } catch (err) {
    if (err instanceof FolderError) {
      return { available: true, reason: null, folder: contentFolder, files: [], skipped: empty, problem: err.message };
    }
    throw err;
  }
}

const folderSchema = z.object({ path: z.string().max(1000) });

/** Set (or clear, with an empty path) the folder imports read from. */
export async function setContentFolder(owner: OwnerContext, mode: 'local' | 'hosted', input: unknown): Promise<FolderStatus> {
  requireLocal(mode);
  const { path } = parseInput(folderSchema, input);
  if (path.trim() === '') {
    await owner.data.studioSettings.setContentFolder(null);
  } else {
    let resolved: string;
    try {
      resolved = await resolveContentFolder(path);
    } catch (err) {
      return folderError(err);
    }
    await owner.data.studioSettings.setContentFolder(resolved);
    await owner.data.audit.record({ actor: owner.actor, action: 'studio.content_folder_set', entityType: 'studio_settings' });
  }
  return getFolderStatus(owner, mode);
}

/** Import one file from the configured folder. Always an explicit choice of one file. */
export async function importFolderFile(owner: OwnerContext, mode: 'local' | 'hosted', input: unknown): Promise<ImportResult> {
  requireLocal(mode);
  const { path } = parseInput(folderSchema, input);
  const { contentFolder } = await owner.data.studioSettings.get();
  if (!contentFolder) throw new ActionError('invalid', 'Choose a content folder first.');
  let file;
  try {
    file = await readMarkdownFile(contentFolder, path);
  } catch (err) {
    return folderError(err);
  }
  let parsed: ParsedDocument;
  try {
    parsed = parseMarkdownDocument(file.text, file.path);
  } catch (err) {
    return documentError(err);
  }
  return saveParsed(owner, parsed, { kind: 'folder', ref: file.path });
}

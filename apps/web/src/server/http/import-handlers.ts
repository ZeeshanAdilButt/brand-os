import { ActionError } from '../actions/owner';
import { getFolderStatus, importFile, importFolderFile, importUrl, setContentFolder } from '../actions/import';
import { MAX_IMPORT_BYTES } from '../import/document';
import { json, readJson, withOwner, type HandlerDeps } from './handlers';

export function handleImportFile(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES + 64 * 1024) {
      throw new ActionError('too_large', 'The file is larger than 1 MB.');
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ActionError('invalid', 'Send the file as multipart form data in a field named "file".');
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw new ActionError('invalid', 'Send the file as multipart form data in a field named "file".');
    if (file.size > MAX_IMPORT_BYTES) throw new ActionError('too_large', 'The file is larger than 1 MB.');
    const result = await importFile(owner, { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    return json(result, 201);
  });
}

export function handleImportUrl(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await importUrl(owner, await readJson(request), deps.urlImport), 201));
}

export function handleFolderGet(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await getFolderStatus(owner, ctx.config.mode)));
}

export function handleFolderSet(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await setContentFolder(owner, ctx.config.mode, await readJson(request))));
}

export function handleFolderImport(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner, ctx) => json(await importFolderFile(owner, ctx.config.mode, await readJson(request)), 201));
}

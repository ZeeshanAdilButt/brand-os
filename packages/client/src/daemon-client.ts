/**
 * Typed HTTP client for the daemon's loopback API (`/api/*`), shared by the MCP server and the CLI.
 * Request and response shapes come from `@cph/daemon/api`, which pulls in zod and nothing else.
 *
 * Every non-2xx answer becomes a `DaemonApiError` carrying the HTTP status and the daemon's
 * `{code, message}` body (codes mix UPPER_CASE gate codes and kebab-case service codes, so callers
 * branch on `status` first). A connection that cannot be made is a `DaemonUnavailableError`.
 */
import {
  ApprovalCardResponse,
  ApprovalRequestResponse,
  ApprovalStatusResponse,
  ApproveChatResponse,
  CheckResponse,
  ConnectionsResponse,
  ContentDetailResponse,
  ContentListResponse,
  DraftListResponse,
  DraftResponse,
  ErrorBody,
  HandoffResponse,
  LogResponse,
  LoginNonceResponse,
  OpenDashboardResponse,
  PreviewResponse,
  PublishResponse,
  RecordPublicationResponse,
  StageResponse,
  SyncResponse,
  type CreateDraftRequest,
} from '@cph/daemon/api';
import type { z } from 'zod';

/** The daemon could not be reached (connection refused, DNS, reset, or no answer within the timeout). */
export class DaemonUnavailableError extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = 'DaemonUnavailableError';
  }
}

/** The daemon answered with a non-2xx status. */
export class DaemonApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DaemonApiError';
  }
}

/** The daemon answered 2xx with a body that does not match the contract. */
export class DaemonProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonProtocolError';
  }
}

export interface DaemonClientOptions {
  /** `http://127.0.0.1:4646`. */
  baseUrl: string;
  /** A scoped API token (`cph_mcp_...` or `cph_cli_...`). Sent only as the Authorization header. */
  token: string;
  fetchFn?: typeof fetch;
  /** Per-request limit in milliseconds. Default 60 000 (a stage or a publish talks to a platform). */
  timeoutMs?: number;
}

export type PreviewPlatform = CreateDraftRequest['platform'];
export type DraftFilter = { slug?: string; platform?: string; status?: string };
export type LogFilter = { limit?: number; draftId?: string };

/** The surface the MCP server and the CLI use; `DaemonClient` implements it and tests fake it. */
export interface DaemonApi {
  sync(): Promise<z.infer<typeof SyncResponse>>;
  listContent(): Promise<z.infer<typeof ContentListResponse>>;
  getContent(slug: string): Promise<z.infer<typeof ContentDetailResponse>>;
  listConnections(): Promise<z.infer<typeof ConnectionsResponse>>;
  openDashboard(page: string): Promise<z.infer<typeof OpenDashboardResponse>>;
  loginNonce(page?: string): Promise<z.infer<typeof LoginNonceResponse>>;
  preview(slug: string, platform: PreviewPlatform): Promise<z.infer<typeof PreviewResponse>>;
  createDraft(input: z.input<typeof CreateDraftRequest>): Promise<z.infer<typeof DraftResponse>>;
  listDrafts(filter?: DraftFilter): Promise<z.infer<typeof DraftListResponse>>;
  getDraft(id: string): Promise<z.infer<typeof DraftResponse>>;
  updateDraft(id: string, payload: Record<string, unknown>): Promise<z.infer<typeof DraftResponse>>;
  stageDraft(id: string): Promise<z.infer<typeof StageResponse>>;
  checkDraft(id: string): Promise<z.infer<typeof CheckResponse>>;
  requestApproval(draftId: string): Promise<z.infer<typeof ApprovalRequestResponse>>;
  getApproval(approvalId: string): Promise<z.infer<typeof ApprovalStatusResponse>>;
  /** The approval as the chat prompt shows it (read-only). */
  getApprovalCard(approvalId: string): Promise<z.infer<typeof ApprovalCardResponse>>;
  /** mcp token only: records an approval the user answered in Claude Code. `checked` is every checklist box, verbatim. */
  approveInChat(approvalId: string, checked: string[]): Promise<z.infer<typeof ApproveChatResponse>>;
  publish(draftId: string, approvalId: string): Promise<z.infer<typeof PublishResponse>>;
  handOff(draftId: string, approvalId: string): Promise<z.infer<typeof HandoffResponse>>;
  recordPublication(draftId: string, url: string): Promise<z.infer<typeof RecordPublicationResponse>>;
  getLog(filter?: LogFilter): Promise<z.infer<typeof LogResponse>>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const enc = encodeURIComponent;

export class DaemonClient implements DaemonApi {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: DaemonClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#token = opts.token;
    // Resolved per call, not captured, so a test that swaps globalThis.fetch is honoured.
    this.#fetch = opts.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async #request<S extends z.ZodType>(method: string, path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}`, accept: 'application/json' };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.#timeoutMs) };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/api${path}`, init);
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new DaemonUnavailableError(`the daemon did not answer within ${this.#timeoutMs} ms`, true);
      }
      throw new DaemonUnavailableError('the daemon could not be reached');
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const parsed = ErrorBody.safeParse(json);
      if (parsed.success) throw new DaemonApiError(res.status, parsed.data.code, parsed.data.message, parsed.data.detail);
      throw new DaemonApiError(res.status, `HTTP_${res.status}`, `the daemon answered ${res.status}`);
    }
    const result = schema.safeParse(json);
    if (!result.success) throw new DaemonProtocolError(`unexpected answer from ${method} ${path}`);
    return result.data;
  }

  sync() {
    return this.#request('POST', '/sync', SyncResponse, {});
  }
  listContent() {
    return this.#request('GET', '/content', ContentListResponse);
  }
  getContent(slug: string) {
    return this.#request('GET', `/content/${enc(slug)}`, ContentDetailResponse);
  }
  listConnections() {
    return this.#request('GET', '/connections', ConnectionsResponse);
  }
  openDashboard(page: string) {
    return this.#request('POST', '/open-dashboard', OpenDashboardResponse, { page });
  }
  /** cli scope only. */
  loginNonce(page?: string) {
    return this.#request('POST', '/dashboard-login-nonce', LoginNonceResponse, page === undefined ? {} : { page });
  }
  preview(slug: string, platform: PreviewPlatform) {
    return this.#request('GET', `/preview/${enc(slug)}/${enc(platform)}`, PreviewResponse);
  }
  createDraft(input: z.input<typeof CreateDraftRequest>) {
    return this.#request('POST', '/drafts', DraftResponse, input);
  }
  listDrafts(filter: DraftFilter = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) if (value !== undefined) query.set(key, value);
    const qs = query.toString();
    return this.#request('GET', qs === '' ? '/drafts' : `/drafts?${qs}`, DraftListResponse);
  }
  getDraft(id: string) {
    return this.#request('GET', `/drafts/${enc(id)}`, DraftResponse);
  }
  updateDraft(id: string, payload: Record<string, unknown>) {
    return this.#request('PATCH', `/drafts/${enc(id)}`, DraftResponse, { payload });
  }
  stageDraft(id: string) {
    return this.#request('POST', `/drafts/${enc(id)}/stage`, StageResponse, {});
  }
  checkDraft(id: string) {
    return this.#request('POST', `/drafts/${enc(id)}/check`, CheckResponse, {});
  }
  requestApproval(draftId: string) {
    return this.#request('POST', '/approvals', ApprovalRequestResponse, { draftId });
  }
  getApproval(approvalId: string) {
    return this.#request('GET', `/approvals/${enc(approvalId)}`, ApprovalStatusResponse);
  }
  getApprovalCard(approvalId: string) {
    return this.#request('GET', `/approvals/${enc(approvalId)}/card`, ApprovalCardResponse);
  }
  approveInChat(approvalId: string, checked: string[]) {
    return this.#request('POST', `/approvals/${enc(approvalId)}/approve-chat`, ApproveChatResponse, { checked, mode: 'approve_only' });
  }
  publish(draftId: string, approvalId: string) {
    return this.#request('POST', '/publish', PublishResponse, { draftId, approvalId });
  }
  handOff(draftId: string, approvalId: string) {
    return this.#request('POST', `/drafts/${enc(draftId)}/handoff`, HandoffResponse, { approvalId });
  }
  recordPublication(draftId: string, url: string) {
    return this.#request('POST', '/publications', RecordPublicationResponse, { draftId, url });
  }
  getLog(filter: LogFilter = {}) {
    const query = new URLSearchParams();
    if (filter.limit !== undefined) query.set('limit', String(filter.limit));
    if (filter.draftId !== undefined) query.set('draftId', filter.draftId);
    const qs = query.toString();
    return this.#request('GET', qs === '' ? '/log' : `/log?${qs}`, LogResponse);
  }
}

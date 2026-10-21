import { readFileSync } from 'node:fs';
import type { Draft, PlatformId } from '@cph/core';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { errorText, type Audit } from '../audit.js';
import type { Config } from '../config.js';
import { dryRunKey, type Approval, type Repos } from '../db/repos.js';
import type { ApprovalGate } from '../gate/approval-gate.js';
import { GateError } from '../gate/errors.js';
import { isPast } from '../gate/prechecks.js';
import type { PresenceVerifier } from '../gate/presence.js';
import { PUBLISHING_ENABLED_KEY, setPublishingEnabled } from '../gate/publishing.js';
import { silentLogger, type Logger } from '../log.js';
import { validateLinkedinPostUrl } from '../routes/assist-linkedin.js';
import { BUFFER_PUBLISH_URL } from '../routes/buffer.js';
import type { RouteRegistry } from '../routes/registry.js';
import type { Health } from '../routes/types.js';
import { redact } from '../secrets/redact.js';
import type { ApiBudget } from '../services/api-budget.js';
import type { ConnectionsService, ConnectionView } from '../services/connections.js';
import type { DraftsService } from '../services/drafts.js';
import type { DashboardChannel, PublishResult, PublishService } from '../services/publish.js';
import type { RecoveryService } from '../services/recovery.js';
import { isDashboardPage } from './api.js';
import { approvalState, errorResponse } from './app.js';
import { SESSION_COOKIE, type LoginNonceStore, type SessionStore } from './auth.js';
import { approvalCard, approvalsView, redCard, type ApprovalCardView, type RedCardView } from './views/approvals.js';
import { connectBufferCard } from './views/connect-buffer.js';
import { connectDevtoCard } from './views/connect-devto.js';
import { connectionsView } from './views/connections.js';
import { contentMatrix, type ContentMatrixRow } from './views/content.js';
import { draftSection } from './views/draft.js';
import { draftsList } from './views/drafts.js';
import { html, type SafeHtml } from './views/html.js';
import { DASHBOARD_JS, errorPage, layout, notice, platformLabel, signInPage, type NavPage, type PageContext } from './views/layout.js';
import { logView } from './views/log.js';
import { dryRunSection, publishingSection, settingsView } from './views/settings.js';

/** What the dashboard needs of the Buffer route: the channel list and the mapping. */
export interface BufferChannelsAccess {
  linkedinChannels(account: string): { id: string; name: string }[];
  mapChannel(account: string, channelId: string): Health;
}

export interface DashboardDeps {
  sessions: SessionStore;
  nonces: LoginNonceStore;
  repos: Repos;
  gate: Pick<ApprovalGate, 'approve' | 'deny' | 'checklist'>;
  publish: Pick<PublishService, 'approveAndPublish' | 'approveAndHandOff'>;
  drafts: Pick<DraftsService, 'update' | 'confirmRemoteCancelled'>;
  recovery: Pick<RecoveryService, 'checkOnPlatform' | 'resolveByHand'>;
  connections: Pick<ConnectionsService, 'list' | 'connect'>;
  /** Windows Hello in production: every Hello-gated action asks it in the daemon's own process. */
  presence: PresenceVerifier;
  /** The channel recorded for human-confirmed actions: 'dashboard_hello' (default) or 'dashboard_click' (click mode). */
  channel?: DashboardChannel;
  routes: RouteRegistry;
  /** The Buffer route, for the LinkedIn channel mapping. */
  bufferChannels?: BufferChannelsAccess;
  budget: Pick<ApiBudget, 'snapshot' | 'allows'>;
  config: () => Config;
  /** False while the master key is missing (degraded mode). */
  secretsReady: () => boolean;
  audit: Audit;
  now?: () => Date;
  log?: Logger;
}

type Form = Record<string, string[]>;
type Vars = { Variables: { session: string; csrf: string; form: Form } };
type Ctx = Context<Vars>;

const ACCOUNT = 'default';
const ACTOR = 'dashboard';
const DEFAULT_PAGE = '/approvals';
const MAX_BODY_BYTES = 64 * 1024;
/** The platforms with a dry-run switch in Phase 0. */
const DRY_RUN_PLATFORMS: readonly PlatformId[] = ['devto', 'linkedin'];
const CSRF_HEADER = 'hx-csrf';

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

let htmxSource: string | undefined;
/** The vendored htmx 2.0.11, next to this module (copied into dist/ by scripts/copy-assets.mjs). */
function htmx(): string {
  htmxSource ??= readFileSync(new URL('./static/htmx.min.js', import.meta.url), 'utf8');
  return htmxSource;
}

let cssSource: string | undefined;
/** The dashboard stylesheet, next to this module (copied into dist/ by scripts/copy-assets.mjs). */
function appCss(): string {
  cssSource ??= readFileSync(new URL('./static/app.css', import.meta.url), 'utf8');
  return cssSource;
}

/** `next` from the login URL when it names an allowlisted page; anything else lands on the approvals queue. */
export function safeNext(next: string | null): string {
  if (next === null || !next.startsWith('/')) return DEFAULT_PAGE;
  return isDashboardPage(next.slice(1)) ? next : DEFAULT_PAGE;
}

/** Form fields (urlencoded or multipart) or a flat JSON object, as lists of strings. Files are dropped. */
async function readForm(c: Ctx): Promise<Form> {
  const type = c.req.header('content-type') ?? '';
  const form: Form = {};
  const add = (key: string, value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') (form[key] ??= []).push(String(value));
  };
  if (type.includes('application/json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await c.req.text());
    } catch {
      return form;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) for (const v of Array.isArray(value) ? value : [value]) add(key, v);
    }
    return form;
  }
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const body = await c.req.parseBody({ all: true });
    for (const [key, value] of Object.entries(body)) for (const v of Array.isArray(value) ? value : [value]) add(key, v);
  }
  return form;
}

/** A link only for an https URL; anything else (javascript:, data:, http:) is shown as plain escaped text. */
export function safeLink(url: string): SafeHtml {
  let https = false;
  try {
    https = new URL(url).protocol === 'https:';
  } catch {
    https = false;
  }
  return https ? html`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>` : html`<code>${url}</code>`;
}

const field = (form: Form, name: string): string | undefined => form[name]?.[0];
const fields = (form: Form, name: string): string[] => form[name] ?? [];
const isHx = (c: Ctx): boolean => c.req.header('hx-request') === 'true';

/** A refusal or failure as a notice, with the status the response gets. */
function failure(error: unknown): { status: ContentfulStatusCode; code: string; note: SafeHtml } {
  const { status, body } = errorResponse(error);
  const code = body.code;
  const finalStatus: ContentfulStatusCode = code === 'CHECKLIST_INCOMPLETE' ? 422 : status;
  return { status: finalStatus, code, note: html`<div class="notice error" role="alert" data-code="${code}"><strong>${code}</strong>: ${body.message}</div>` };
}

/**
 * The cookie-authenticated dashboard (spec 2.6 rule 2, section 4; T0.19). Threat model: Claude can
 * get a signed-in tab (open_dashboard) and drive the browser, so every state-changing action is
 * either verified by Windows Hello in the daemon's own process, or harmless and fails closed:
 *
 * - Hello: Approve & publish / Approve only / Approve & schedule (through the gate), Publishing
 *   ENABLED, a LinkedIn channel change, marking an unknown publish by hand, confirming a remote
 *   cancel, turning a platform's dry run OFF;
 * - harmless: Deny, Publishing DISABLED, dry run ON, Check on platform, connecting a key (it is the
 *   user's own; a wrong key only fails its health check), editing a draft (it cancels approvals).
 *
 * Also: API bearer tokens are refused on every route; the `cph_session` cookie (HttpOnly,
 * SameSite=Strict) is minted only by `GET /login` with a one-time nonce; every POST and PATCH needs
 * the session's CSRF token; every page is escaped by default and never shows a secret.
 */
export function createDashboardRouter(deps: DashboardDeps): Hono<Vars> {
  const { repos, sessions } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLogger;
  const app = new Hono<Vars>();
  const humanChannel: DashboardChannel = deps.channel ?? 'dashboard_hello';
  const clickMode = humanChannel === 'dashboard_click';

  // ---- every request ----

  app.use('*', async (c, next) => {
    if (c.req.header('authorization') !== undefined) {
      return c.json({ code: 'FORBIDDEN', message: 'the dashboard does not accept API tokens; sign in through `cph dashboard`' }, 403);
    }
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
  });

  // ---- before the session guard: static files, the sign-in page, /login ----

  app.get('/static/htmx.min.js', (c) => c.body(htmx(), 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  app.get('/static/dashboard.js', (c) => c.body(DASHBOARD_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  app.get('/static/app.css', (c) => c.body(appCss(), 200, { 'Content-Type': 'text/css; charset=utf-8' }));
  // The stylesheet's earlier name, kept so a page cached before the rename still finds it.
  app.get('/static/dashboard.css', (c) => c.body(appCss(), 200, { 'Content-Type': 'text/css; charset=utf-8' }));
  app.get('/signin', (c) => c.html(signInPage().value));

  app.get('/login', (c) => {
    // Read through URLSearchParams; the request log records the path only, never this query.
    const params = new URL(c.req.url).searchParams;
    if (!deps.nonces.consume(params.get('nonce') ?? '')) {
      return c.html(errorPage('Sign-in link not valid', 'This sign-in link was already used or has expired.').value, 403);
    }
    const { cookie } = sessions.create();
    setCookie(c, SESSION_COOKIE, cookie, { httpOnly: true, sameSite: 'Strict', path: '/' });
    deps.audit({ actorChannel: ACTOR, action: 'signed_in' });
    return c.redirect(safeNext(params.get('next')), 303);
  });

  // ---- the session guard and CSRF ----

  app.use('*', async (c, next) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    const csrf = cookie === undefined ? undefined : sessions.csrfFor(cookie);
    if (cookie === undefined || csrf === undefined) {
      if (c.req.method === 'GET' || c.req.method === 'HEAD') {
        if (isHx(c)) c.header('HX-Redirect', '/signin');
        return c.redirect('/signin', 303);
      }
      return c.html(errorPage('Signed out', 'This dashboard session has ended.').value, 403);
    }
    c.set('session', cookie);
    c.set('csrf', csrf);
    await next();
  });

  app.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.text('the request body is too large', 413) }));

  app.use('*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      c.set('form', {});
      return next();
    }
    const form = await readForm(c);
    const presented = c.req.header(CSRF_HEADER) ?? field(form, '_csrf');
    if (!sessions.checkCsrf(c.get('session'), presented)) {
      return c.html(errorPage('Refused', 'The request did not carry this session’s CSRF token.').value, 403);
    }
    c.set('form', form);
    await next();
  });

  // ---- rendering helpers ----

  /** `failure`, plus a line in the (redacting) daemon log for anything that is not a refusal (5xx). */
  const fail = (c: Ctx, error: unknown): ReturnType<typeof failure> => {
    const result = failure(error);
    if (result.status >= 500) log('error', `${c.req.method} ${new URL(c.req.url).pathname}: ${errorText(error)}`);
    return result;
  };

  const publishingOn = (): boolean => repos.settings.get(PUBLISHING_ENABLED_KEY) === 'true';
  const pageContext = (c: Ctx): PageContext => ({
    csrf: c.get('csrf'),
    publishingEnabled: publishingOn(),
    bufferBudgetLow: !deps.budget.allows('buffer', 'probe'),
    secretsReady: deps.secretsReady(),
    approvalMode: clickMode ? 'click' : 'hello',
    pendingApprovals: pendingApprovals().length,
    holds: redCards(c.get('csrf')).length,
  });
  const page = (c: Ctx, title: string, nav: NavPage | undefined, content: SafeHtml, status: ContentfulStatusCode = 200): Response =>
    c.html(layout(title, nav, pageContext(c), content).value, status);
  /** htmx gets the fragment it swaps in; a plain form post gets the whole page. */
  const respond = (c: Ctx, title: string, nav: NavPage | undefined, content: SafeHtml, status: ContentfulStatusCode = 200): Response =>
    isHx(c) ? c.html(content.value, status) : page(c, title, nav, content, status);

  /** Asks Windows Hello (in this process) with a prompt naming the action. Fails closed; a refusal is audited. */
  const hello = async (prompt: string, action: string, target: { draftId?: string; platform?: string } = {}): Promise<{ ok: boolean; result: string }> => {
    let result: string;
    try {
      result = await deps.presence.verify(prompt);
    } catch {
      result = 'error';
    }
    if (result !== 'verified') {
      deps.audit({ actorChannel: humanChannel, action: `${action}_refused`, ...target, detail: { code: 'PRESENCE_FAILED', result } });
    }
    return { ok: result === 'verified', result };
  };
  const helloRefused = (result: string, what: string): SafeHtml =>
    notice('error', html`<strong>PRESENCE_FAILED</strong>: Windows Hello was not verified (${result}). ${what}`);

  // ---- approvals ----

  const cardView = (csrf: string, approval: Approval, note?: SafeHtml): ApprovalCardView | undefined => {
    const draft = repos.drafts.get(approval.draftId);
    if (draft === undefined) return undefined;
    const state = approvalState(repos, approval, now());
    const view: ApprovalCardView = {
      csrf,
      approval,
      draft,
      state: state.status,
      costUsd: deps.routes.get(draft.platform, draft.route)?.costEstimate(draft) ?? 0,
      ...(clickMode ? { click: true } : {}),
    };
    if (state.status === 'pending') {
      try {
        view.checklist = deps.gate.checklist(draft.id);
      } catch {
        // The post cannot be read: the card says so and shows no buttons.
      }
    }
    if (draft.route === 'buffer') {
      const mapped = deps.config().platforms.linkedin?.bufferChannelId;
      const channel = deps.bufferChannels?.linkedinChannels(draft.account).find((ch) => ch.id === mapped);
      if (channel !== undefined) view.channelName = channel.name;
      view.budget = deps.budget.snapshot('buffer');
    }
    const published =
      note === undefined && state.remoteUrl !== undefined
        ? notice('ok', html`Published: ${safeLink(state.remoteUrl)}`)
        : undefined;
    const shown = note ?? published;
    if (shown !== undefined) view.notice = shown;
    return view;
  };

  const pendingApprovals = (): Approval[] => {
    const at = now();
    const out: Approval[] = [];
    for (const draft of repos.drafts.list()) {
      for (const approval of repos.approvals.listByDraft(draft.id)) {
        if (approval.status === 'pending' && approval.usedAt === undefined && !isPast(approval.expiresAt, at)) out.push(approval);
      }
    }
    return out.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  };

  const redFor = (csrf: string, draft: Draft, note?: SafeHtml): RedCardView | undefined => {
    const base = { csrf, draft, ...(note === undefined ? {} : { notice: note }) };
    const reason = draft.failureReason;
    if (draft.status === 'unknown') return { ...base, kind: 'unknown', ...(reason === undefined ? {} : { reason }) };
    if (draft.status === 'failed') return { ...base, kind: 'failed', ...(reason === undefined ? {} : { reason }) };
    if (draft.remoteScheduledId !== undefined && draft.status !== 'scheduled' && draft.status !== 'published') {
      return {
        ...base,
        kind: 'cancel_failed',
        reason: 'The draft changed, but the platform still holds the old scheduled post and the cancel did not go through.',
        ...(draft.route === 'buffer' ? { manualUrl: BUFFER_PUBLISH_URL } : {}),
      };
    }
    const last = repos.audit.list({ draftId: draft.id, limit: 1 })[0];
    if (last?.action === 'stage_failed' && (draft.status === 'draft' || draft.status === 'staged')) {
      const detail = last.detail as { error?: unknown } | undefined;
      return { ...base, kind: 'stage_failed', ...(typeof detail?.error === 'string' ? { reason: redact(detail.error) } : {}) };
    }
    if (last?.action === 'remote_cancelled') return { ...base, kind: 'remote_cancelled' };
    return undefined;
  };

  const redCards = (csrf: string): RedCardView[] =>
    repos.drafts.list().flatMap((draft) => {
      const card = redFor(csrf, draft);
      return card === undefined ? [] : [card];
    });

  app.get('/', (c) => c.redirect(DEFAULT_PAGE, 303));

  app.get('/approvals', (c) => {
    const csrf = c.get('csrf');
    const cards = pendingApprovals().flatMap((a) => cardView(csrf, a) ?? []);
    return page(c, 'Approvals', 'approvals', approvalsView({ red: redCards(csrf), cards }));
  });

  app.get('/approvals/:id', (c) => {
    const csrf = c.get('csrf');
    const approval = repos.approvals.get(c.req.param('id'));
    const card = approval === undefined ? undefined : cardView(csrf, approval);
    const content = approvalsView({ red: redCards(csrf), cards: card === undefined ? [] : [card], single: true });
    return page(c, 'Approval', 'approvals', content, card === undefined ? 404 : 200);
  });

  /** The card for `approvalId` as it is now, with `note` on top. */
  const cardResponse = (c: Ctx, approvalId: string, note: SafeHtml, status: ContentfulStatusCode): Response => {
    const approval = repos.approvals.get(approvalId);
    const view = approval === undefined ? undefined : cardView(c.get('csrf'), approval, note);
    return respond(c, 'Approval', 'approvals', view === undefined ? note : approvalCard(view), status);
  };

  const publishNote = (result: PublishResult): SafeHtml => {
    switch (result.status) {
      case 'published':
        return notice(
          'ok',
          result.remoteUrl === undefined
            ? html`Published (Windows Hello verified).`
            : html`Published (Windows Hello verified): ${safeLink(result.remoteUrl)}`,
        );
      case 'dry_run':
        return notice('info', 'Dry run: the post was rendered and logged, and nothing was sent. The approval is spent.');
      case 'unknown':
        return notice('error', html`<strong>Result unknown</strong>: ${result.error ?? ''} It may be live. Use "Check on platform" before anything else; it will not be retried.`);
      default:
        return notice('error', html`<strong>Not published</strong>: ${result.error ?? ''} Nothing went out; a new approval can follow.`);
    }
  };

  app.post('/approvals/:id/approve', async (c) => {
    const id = c.req.param('id');
    const form = c.get('form');
    const approval = repos.approvals.get(id);
    const draft = approval === undefined ? undefined : repos.drafts.get(approval.draftId);
    if (approval === undefined || draft === undefined) return respond(c, 'Approval', 'approvals', notice('error', 'No such approval.'), 404);
    const action = field(form, 'action');
    const checked = fields(form, 'checked');
    try {
      if (action === 'only') {
        await deps.gate.approve(id, { channel: humanChannel, checked, mode: 'approve_only' });
        return cardResponse(c, id, notice('ok', 'Approved (Windows Hello verified). Claude can publish it with this approval before it expires.'), 200);
      }
      if (action === 'schedule') {
        await deps.gate.approve(id, { channel: humanChannel, checked, mode: 'schedule' });
        return cardResponse(c, id, notice('ok', html`Approved (Windows Hello verified) to go out at ${draft.scheduledAt ?? 'its scheduled time'}.`), 200);
      }
      if (action === 'publish' && draft.scheduledAt !== undefined) {
        return cardResponse(c, id, notice('error', 'This draft is scheduled: use Approve & schedule, which keeps its time.'), 409);
      }
      if (action === 'publish' && !publishingOn()) {
        // Checked before Hello: an Approve & publish approval that cannot be spent would only sit there.
        const why = html`<strong>PUBLISHING_DISABLED</strong>: set Publishing to ENABLED in <a href="/settings">Settings</a> first. Nothing was approved.`;
        return cardResponse(c, id, notice('error', why), 409);
      }
      if (action === 'publish' && draft.route === 'assist') {
        const kit = await deps.publish.approveAndHandOff(id, { checked });
        const page = safeLink(kit.openUrl);
        return cardResponse(c, id, notice('ok', html`Approved and handed off: the text is on the clipboard and ${page} is open. Post it there yourself, then record the post's URL.`), 200);
      }
      if (action === 'publish') {
        const result = await deps.publish.approveAndPublish(id, { checked });
        return cardResponse(c, id, publishNote(result), 200);
      }
      return cardResponse(c, id, notice('error', 'Unknown action.'), 400);
    } catch (error) {
      const { status, code, note } = fail(c, error);
      const after = repos.approvals.get(id)?.status;
      let text: SafeHtml = note;
      if (code === 'PRESENCE_FAILED') {
        const result = error instanceof GateError && typeof error.detail?.['result'] === 'string' ? error.detail['result'] : 'not verified';
        text = html`${note}${notice('warn', html`Windows Hello was not verified (${result}). The approval is still ${after ?? 'pending'}; nothing was approved.`)}`;
      } else if (after === 'approved') {
        text = html`${note}${notice('warn', 'The approval was recorded, but the post did not go out.')}`;
      }
      return cardResponse(c, id, text, status);
    }
  });

  app.post('/approvals/:id/deny', (c) => {
    const id = c.req.param('id');
    try {
      deps.gate.deny(id, { channel: humanChannel });
      return cardResponse(c, id, notice('info', 'Denied.'), 200);
    } catch (error) {
      const { status, note } = fail(c, error);
      return cardResponse(c, id, note, status);
    }
  });

  // ---- red-card actions on a draft ----

  /** The draft's red card if it still needs one, else a plain card with the notice. */
  const redResponse = (c: Ctx, draftId: string, note: SafeHtml, status: ContentfulStatusCode): Response => {
    const draft = repos.drafts.get(draftId);
    const card = draft === undefined ? undefined : redFor(c.get('csrf'), draft, note);
    const body = card === undefined ? html`<article class="card" id="red-${draftId}">${note}</article>` : redCard(card);
    return respond(c, 'Approvals', 'approvals', body, status);
  };
  const noDraft = (c: Ctx): Response => respond(c, 'Draft', 'approvals', notice('error', 'No such draft.'), 404);

  app.post('/drafts/:id/check', async (c) => {
    const draft = repos.drafts.get(c.req.param('id'));
    if (draft === undefined) return noDraft(c);
    try {
      const outcome = await deps.recovery.checkOnPlatform(draft.id);
      const text =
        outcome === 'published'
          ? notice('ok', 'Found live on the platform: recorded as published.')
          : outcome === 'failed'
            ? notice('info', 'Not live on the platform: marked as not posted. A new approval can follow.')
            : notice('warn', 'The platform could not say. Look on the platform and mark it by hand.');
      return redResponse(c, draft.id, text, 200);
    } catch (error) {
      const { status, note } = fail(c, error);
      return redResponse(c, draft.id, note, status);
    }
  });

  app.post('/drafts/:id/resolve', async (c) => {
    const draft = repos.drafts.get(c.req.param('id'));
    if (draft === undefined) return noDraft(c);
    const form = c.get('form');
    const outcome = field(form, 'outcome');
    if (outcome !== 'published' && outcome !== 'failed') return redResponse(c, draft.id, notice('error', 'Choose posted or not posted.'), 400);
    const url = field(form, 'remoteUrl')?.trim();
    if (url !== undefined && url !== '') {
      // Checked before Hello, so a mistyped URL costs no prompt (resolveByHand checks it again).
      try {
        if (draft.platform === 'linkedin') validateLinkedinPostUrl(url);
        else if (new URL(url).protocol !== 'https:') throw new Error('the post URL must be https');
      } catch (error) {
        return redResponse(c, draft.id, notice('error', html`<strong>invalid-url</strong>: ${errorText(error)}`), 422);
      }
    }
    const verdict = await hello(
      `Mark ${platformLabel(draft.platform)} post for ${draft.slug} as ${outcome === 'published' ? 'posted' : 'not posted'}`,
      'resolve_by_hand',
      { draftId: draft.id, platform: draft.platform },
    );
    if (!verdict.ok) return redResponse(c, draft.id, helloRefused(verdict.result, 'Nothing was marked.'), 409);
    try {
      deps.recovery.resolveByHand(draft.id, outcome, { actor: humanChannel, ...(url === undefined || url === '' ? {} : { remoteUrl: url }) });
      return redResponse(c, draft.id, notice('ok', outcome === 'published' ? 'Marked as posted.' : 'Marked as not posted. A new approval can follow.'), 200);
    } catch (error) {
      const { status, note } = fail(c, error);
      return redResponse(c, draft.id, note, status);
    }
  });

  app.post('/drafts/:id/confirm-cancelled', async (c) => {
    const draft = repos.drafts.get(c.req.param('id'));
    if (draft === undefined) return noDraft(c);
    const verdict = await hello(`Confirm the scheduled ${platformLabel(draft.platform)} post for ${draft.slug} is deleted`, 'remote_cancel_confirm', {
      draftId: draft.id,
      platform: draft.platform,
    });
    if (!verdict.ok) return redResponse(c, draft.id, helloRefused(verdict.result, 'The hold stays.'), 409);
    try {
      deps.drafts.confirmRemoteCancelled(draft.id, humanChannel);
      return redResponse(c, draft.id, notice('ok', 'Recorded. The draft can be approved again.'), 200);
    } catch (error) {
      const { status, note } = fail(c, error);
      return redResponse(c, draft.id, note, status);
    }
  });

  // ---- drafts ----

  app.get('/drafts', (c) => {
    const drafts = repos.drafts.list().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return page(c, 'Drafts', 'drafts', draftsList(drafts));
  });

  app.get('/drafts/:id', (c) => {
    const draft = repos.drafts.get(c.req.param('id'));
    if (draft === undefined) return page(c, 'Draft', 'drafts', notice('error', 'No such draft.'), 404);
    return page(c, 'Draft', 'drafts', draftSection({ csrf: c.get('csrf'), draft }));
  });

  app.patch('/drafts/:id', async (c) => {
    const before = repos.drafts.get(c.req.param('id'));
    if (before === undefined) return respond(c, 'Draft', 'drafts', notice('error', 'No such draft.'), 404);
    const csrf = c.get('csrf');
    const text = field(c.get('form'), 'text');
    if (before.platform !== 'linkedin' || text === undefined) {
      return respond(c, 'Draft', 'drafts', draftSection({ csrf, draft: before, notice: notice('error', 'Only a LinkedIn post text can be edited here.') }), 422);
    }
    try {
      // Browsers send textarea line breaks as CRLF; the stored text uses LF.
      await deps.drafts.update(before.id, { text: text.replace(/\r\n/g, '\n') });
    } catch (error) {
      const { status, note } = fail(c, error);
      return respond(c, 'Draft', 'drafts', draftSection({ csrf, draft: repos.drafts.get(before.id) ?? before, notice: note }), status);
    }
    const after = repos.drafts.get(before.id) ?? before;
    const note =
      after.payloadSha256 !== before.payloadSha256
        ? notice('ok', html`Saved. Hash <code>${before.payloadSha256.slice(0, 12)}…</code> → <code>${after.payloadSha256.slice(0, 12)}…</code>; earlier approvals for this draft no longer count.`)
        : notice('info', 'No change.');
    return respond(c, 'Draft', 'drafts', draftSection({ csrf, draft: after, notice: note }));
  });

  // ---- connections ----

  const connection = (platform: PlatformId, route: string): ConnectionView | undefined =>
    deps.connections.list().find((v) => v.platform === platform && v.route === route);
  const devtoCard = (c: Ctx, note?: SafeHtml): SafeHtml => {
    const conn = connection('devto', 'direct');
    return connectDevtoCard({ csrf: c.get('csrf'), ...(conn === undefined ? {} : { connection: conn }), ...(note === undefined ? {} : { notice: note }) });
  };
  const bufferCard = (c: Ctx, note?: SafeHtml): SafeHtml => {
    const conn = connection('linkedin', 'buffer');
    const mapped = deps.config().platforms.linkedin?.bufferChannelId;
    return connectBufferCard({
      csrf: c.get('csrf'),
      channels: (deps.bufferChannels?.linkedinChannels(ACCOUNT) ?? []).map((ch) => ({ id: ch.id, name: ch.name })),
      ...(conn === undefined ? {} : { connection: conn }),
      ...(mapped === undefined ? {} : { mappedChannelId: mapped }),
      ...(note === undefined ? {} : { notice: note }),
    });
  };

  app.get('/connections', (c) => page(c, 'Connections', 'connections', connectionsView(deps.connections.list())));

  app.get('/connections/:platform', (c) => {
    const platform = c.req.param('platform');
    if (platform === 'devto') return page(c, 'Connect dev.to', 'connections', devtoCard(c));
    if (platform === 'buffer' || platform === 'linkedin') return page(c, 'Connect Buffer', 'connections', bufferCard(c));
    return page(c, 'Connections', 'connections', connectionsView(deps.connections.list().filter((v) => v.platform === platform)));
  });

  /** Hands the key to the route (which tests it, then stores it). The key is never shown back, even masked. */
  const connectKey = async (c: Ctx, platform: PlatformId, routeKind: 'direct' | 'buffer', card: (c: Ctx, note?: SafeHtml) => SafeHtml): Promise<Response> => {
    const title = routeKind === 'buffer' ? 'Connect Buffer' : 'Connect dev.to';
    if (!deps.secretsReady()) {
      return respond(c, title, 'connections', card(c, notice('error', html`<strong>NOT_CONFIGURED</strong>: the master key is missing. Run <code>cph install</code> first.`)), 503);
    }
    const apiKey = field(c.get('form'), 'apiKey')?.trim() ?? '';
    const scrub = (text: string): string => (apiKey.length >= 4 ? text.split(apiKey).join('[REDACTED]') : text);
    let note: SafeHtml;
    let status: ContentfulStatusCode = 200;
    try {
      const health = await deps.connections.connect(platform, { apiKey }, { account: ACCOUNT, routeKind });
      if (health.state === 'connected') {
        note = notice('ok', html`Connected${health.who === undefined ? '' : html` as <strong>${scrub(health.who)}</strong>`}. The key is stored encrypted and is never shown again.`);
      } else {
        note = notice('warn', scrub([health.detail, health.nextAction].filter((s) => s !== undefined).join(' ')) || 'Not connected.');
        status = 422;
      }
    } catch (error) {
      note = notice('error', html`<strong>Not connected</strong>: ${scrub(errorText(error))}`);
      status = 502;
    }
    return respond(c, title, 'connections', card(c, note), status);
  };

  app.post('/connections/devto', (c) => connectKey(c, 'devto', 'direct', devtoCard));
  app.post('/connections/buffer', (c) => connectKey(c, 'linkedin', 'buffer', bufferCard));

  app.post('/connections/buffer/channel', async (c) => {
    const title = 'Connect Buffer';
    const access = deps.bufferChannels;
    if (access === undefined) return respond(c, title, 'connections', bufferCard(c, notice('error', 'Buffer is not set up in this daemon.')), 404);
    const channelId = field(c.get('form'), 'channelId') ?? '';
    const channel = access.linkedinChannels(ACCOUNT).find((ch) => ch.id === channelId);
    if (channel === undefined) {
      return respond(c, title, 'connections', bufferCard(c, notice('error', 'That is not a LinkedIn channel in the last list Buffer returned. Reconnect to refresh it.')), 422);
    }
    const current = deps.config().platforms.linkedin?.bufferChannelId;
    if (current === channelId) return respond(c, title, 'connections', bufferCard(c, notice('info', html`Already posting to ${channel.name}.`)));

    // With no LinkedIn config yet (the assist route), mapping a channel also creates route 'buffer':
    // the prompt must say that LinkedIn posts will start going through Buffer.
    const switchesRoute = deps.config().platforms.linkedin === undefined;
    const prompt = switchesRoute ? `Route LinkedIn via Buffer to ${channel.name}` : `Change LinkedIn channel to ${channel.name}`;
    const verdict = await hello(prompt, 'buffer_channel_change', { platform: 'linkedin' });
    if (!verdict.ok) return respond(c, title, 'connections', bufferCard(c, helloRefused(verdict.result, 'The channel did not change.')), 409);

    // The target channel is part of what was approved: cancel every pending or approved LinkedIn approval first.
    const invalidated: string[] = [];
    repos.transaction(() => {
      for (const draft of repos.drafts.list({ platform: 'linkedin' })) {
        for (const a of repos.approvals.listByDraft(draft.id)) {
          if ((a.status === 'pending' || a.status === 'approved') && repos.approvals.setStatus(a.id, 'invalidated', { from: a.status })) invalidated.push(a.id);
        }
      }
    });
    try {
      access.mapChannel(ACCOUNT, channelId);
    } catch (error) {
      const { status, note } = fail(c, error);
      return respond(c, title, 'connections', bufferCard(c, note), status);
    }
    deps.audit({
      actorChannel: humanChannel,
      action: 'buffer_channel_mapped',
      platform: 'linkedin',
      detail: { from: current ?? null, to: channelId, invalidatedApprovals: invalidated },
    });
    const cancelled = invalidated.length === 0 ? '' : ` ${invalidated.length} LinkedIn approval(s) were cancelled; ask for new ones.`;
    return respond(c, title, 'connections', bufferCard(c, notice('ok', html`LinkedIn posts now go to ${channel.name}.${cancelled}`)));
  });

  // ---- content and log ----

  app.get('/content', (c) => {
    const rows: ContentMatrixRow[] = repos.content.list().map((content) => {
      const latest: Partial<Record<string, Draft>> = {};
      for (const draft of repos.drafts.list({ slug: content.slug })) {
        const seen = latest[draft.platform];
        if (seen === undefined || draft.updatedAt > seen.updatedAt) latest[draft.platform] = draft;
      }
      return { content, latest };
    });
    return page(c, 'Content', 'content', contentMatrix(rows));
  });

  app.get('/log', (c) => page(c, 'Log', 'log', logView(repos.audit.list({ limit: 200 }))));

  // ---- settings ----

  const dryRunStates = (): { platform: string; on: boolean }[] =>
    DRY_RUN_PLATFORMS.map((platform) => ({ platform, on: repos.settings.get(dryRunKey(platform)) === 'true' }));

  app.get('/settings', (c) => page(c, 'Settings', 'settings', settingsView({ csrf: c.get('csrf'), publishingEnabled: publishingOn(), dryRun: dryRunStates() })));

  app.post('/settings/publishing', async (c) => {
    const wanted = field(c.get('form'), 'enabled');
    const section = (note: SafeHtml): SafeHtml => publishingSection({ csrf: c.get('csrf'), publishingEnabled: publishingOn(), publishingNotice: note });
    if (wanted !== 'true' && wanted !== 'false') return respond(c, 'Settings', 'settings', section(notice('error', 'enabled must be true or false.')), 400);
    const result = await setPublishingEnabled({ repos, presence: deps.presence, now, actor: humanChannel }, wanted === 'true');
    if (!result.ok) {
      return respond(c, 'Settings', 'settings', section(notice('error', html`<strong>PRESENCE_FAILED</strong>: Windows Hello was not verified. Publishing stays DISABLED.`)), 409);
    }
    // The red banner sits outside the swapped section: reload the page so it appears or goes.
    if (isHx(c)) c.header('HX-Refresh', 'true');
    return respond(c, 'Settings', 'settings', section(notice('ok', wanted === 'true' ? 'Publishing: ENABLED.' : 'Publishing: DISABLED.')));
  });

  app.post('/settings/dry-run/:platform', async (c) => {
    const platform = c.req.param('platform') as PlatformId;
    const section = (note: SafeHtml): SafeHtml => dryRunSection({ csrf: c.get('csrf'), dryRun: dryRunStates(), dryRunNotice: note });
    if (!DRY_RUN_PLATFORMS.includes(platform)) return respond(c, 'Settings', 'settings', section(notice('error', 'No dry run for that platform.')), 404);
    const wanted = field(c.get('form'), 'enabled');
    if (wanted !== 'true' && wanted !== 'false') return respond(c, 'Settings', 'settings', section(notice('error', 'enabled must be true or false.')), 400);
    const label = platformLabel(platform);
    if (wanted === 'true') {
      repos.settings.set(dryRunKey(platform), 'true');
      deps.audit({ actorChannel: ACTOR, action: 'dry_run_on', platform });
      return respond(c, 'Settings', 'settings', section(notice('ok', `${label}: dry run ON. Nothing is sent.`)));
    }
    const verdict = await hello(`Turn off dry run for ${label}`, 'dry_run_off', { platform });
    if (!verdict.ok) return respond(c, 'Settings', 'settings', section(helloRefused(verdict.result, `${label} stays in dry run.`)), 409);
    repos.settings.set(dryRunKey(platform), 'false');
    deps.audit({ actorChannel: humanChannel, action: 'dry_run_off', platform });
    return respond(c, 'Settings', 'settings', section(notice('ok', `${label}: dry run OFF. Approved posts are sent.`)));
  });

  // ---- the rest ----

  app.all('*', (c) => page(c, 'Not found', undefined, notice('error', 'There is no such dashboard page.'), 404));

  app.onError((error, c) => {
    const { status, note } = failure(error);
    if (status >= 500) log('error', `${c.req.method} ${new URL(c.req.url).pathname}: ${errorText(error)}`);
    const csrf = (c as Ctx).get('csrf') as string | undefined;
    if (csrf === undefined) return c.html(errorPage('Error', 'Something went wrong.').value, status);
    return respond(c as Ctx, 'Error', undefined, note, status);
  });

  return app;
}

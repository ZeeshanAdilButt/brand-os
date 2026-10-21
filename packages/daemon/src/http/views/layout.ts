import { html, raw, type SafeHtml } from './html.js';
import { ICONS, type IconName } from './icons.js';

export type NavPage = 'approvals' | 'connections' | 'content' | 'drafts' | 'settings' | 'log';

/** What every signed-in page shows around its content. */
export interface PageContext {
  /** The session's CSRF token: sent by htmx as the `HX-CSRF` header and in every form's `_csrf` field. */
  csrf: string;
  publishingEnabled: boolean;
  /** Under 20% of Buffer's 24 h or 30 d API budget is left (spec 4.4). */
  bufferBudgetLow: boolean;
  /** False while the master key is missing (degraded mode). */
  secretsReady: boolean;
  /** How a human confirms an approval: a dashboard click, or Windows Hello. */
  approvalMode: 'click' | 'hello';
  /** Pending approvals: the count badge on the Approvals nav item. */
  pendingApprovals: number;
  /** Red cards (unknown results, holds) waiting at the top of /approvals. */
  holds: number;
}

const NAV: readonly { page: NavPage; label: string }[] = [
  { page: 'approvals', label: 'Approvals' },
  { page: 'drafts', label: 'Drafts' },
  { page: 'content', label: 'Content' },
  { page: 'connections', label: 'Connections' },
  { page: 'settings', label: 'Settings' },
  { page: 'log', label: 'Log' },
];

/** The small label above each page title. */
const EYEBROWS: Readonly<Record<NavPage, string>> = {
  approvals: 'Review queue',
  drafts: 'Workbench',
  content: 'Library',
  connections: 'Accounts',
  settings: 'Controls',
  log: 'Audit trail',
};

/** One helpful line under each page title, keyed by the title. */
const LEDES: Readonly<Record<string, string>> = {
  Approvals: 'Every post waits here until you read exactly what will be sent and say yes. Nothing goes out on its own.',
  Approval: 'One approval, exactly as it will be sent.',
  Drafts: 'Every draft, newest first. Open one to read its payload and lint, or to edit a LinkedIn post.',
  Draft: 'The payload, its lint results and where it is in the pipeline.',
  Content: 'Your posts from the site, and where each one stands on every platform.',
  Connections: 'Which accounts are connected, as whom, and what to do next.',
  'Connect dev.to': 'Paste a dev.to API key. It is stored encrypted and never shown again.',
  'Connect Buffer': 'Buffer carries LinkedIn posts. Connect it once, then pick the LinkedIn channel.',
  Settings: 'The switches that decide whether anything can leave this machine.',
  Log: 'The last 200 things that happened, newest first. Secrets are redacted.',
};

/**
 * htmx settings: no history cache (it would keep page HTML, CSRF token included, in localStorage),
 * no eval and no inline scripts (the CSP forbids both anyway), no injected indicator styles (the
 * stylesheet has them), same-origin requests only, and swap error responses too, so a refusal card
 * replaces the card that asked.
 */
const HTMX_CONFIG = raw(
  `<meta name="htmx-config" content='${JSON.stringify({
    historyEnabled: false,
    allowEval: false,
    allowScriptTags: false,
    includeIndicatorStyles: false,
    selfRequestsOnly: true,
    responseHandling: [
      { code: '204', swap: false },
      { code: '...', swap: true },
    ],
  })}'>`,
);

/** The hidden form field carrying the CSRF token. */
export function csrfField(csrf: string): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${csrf}">`;
}

function document(title: string, head: SafeHtml, body: SafeHtml): SafeHtml {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light">
${HTMX_CONFIG}
<title>${title} · content-powerhouse</title>
<link rel="stylesheet" href="/static/app.css">
${head}
</head>
${body}
</html>`;
}

const BRAND = html`<span class="brand-mark" aria-hidden="true">cp</span><span class="brand-name">content-powerhouse<small>publishing desk</small></span>`;

function navCount(page: NavPage, ctx: PageContext): SafeHtml | string {
  if (page !== 'approvals') return '';
  const holds = ctx.holds > 0 ? html`<span class="count hold"><span class="sr-only">, </span>${ctx.holds}<span class="sr-only"> need you first</span></span>` : '';
  const pending = html`<span class="count${ctx.pendingApprovals === 0 ? ' zero' : ''}"><span class="sr-only">, </span>${ctx.pendingApprovals}<span class="sr-only"> waiting</span></span>`;
  return html`${holds}${pending}`;
}

function sidebar(active: NavPage | undefined, ctx: PageContext): SafeHtml {
  const items = NAV.map(
    (item) => html`<li class="nav-item"><a href="/${item.page}"${item.page === active ? raw(' aria-current="page"') : ''}>${ICONS[item.page as IconName]}<span class="nav-label">${item.label}</span>${navCount(item.page, ctx)}</a></li>`,
  );
  return html`<aside class="sidebar">
<a class="brand" href="/approvals">${BRAND}</a>
<nav aria-label="Dashboard"><ul class="nav-list">${items}</ul></nav>
<p class="sidebar-foot"><span class="label">Local only</span>This dashboard runs on 127.0.0.1 and talks to nobody else.</p>
</aside>`;
}

function statusBar(ctx: PageContext): SafeHtml {
  const on = ctx.publishingEnabled;
  return html`<div class="statusbar" role="region" aria-label="Status">
<span class="status-item"><span class="label">Publishing</span><span class="flag ${on ? 'on' : 'off'}" data-status-publishing>${on ? 'ENABLED' : 'DISABLED'}</span></span>
<span class="status-item"><span class="label">Approval</span><span class="flag mode">${ctx.approvalMode === 'click' ? 'click' : 'Windows Hello'}</span></span>
<a class="status-link" href="/settings">Settings</a>
</div>`;
}

/** A signed-in page: navigation, the status bar, the state banners, and `content`. */
export function layout(title: string, active: NavPage | undefined, ctx: PageContext, content: SafeHtml): SafeHtml {
  const head = html`<meta name="csrf-token" content="${ctx.csrf}">
<script src="/static/htmx.min.js" defer></script>
<script src="/static/dashboard.js" defer></script>`;
  const lede = LEDES[title];
  const body = html`<body hx-headers="${JSON.stringify({ 'HX-CSRF': ctx.csrf })}">
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
${sidebar(active, ctx)}
<div class="main-col">
${statusBar(ctx)}
${banners(ctx)}
<main id="main">
<header class="page-head">
${active === undefined ? '' : html`<p class="eyebrow">${EYEBROWS[active]}</p>`}
<h1>${title}</h1>
${lede === undefined ? '' : html`<p class="lede">${lede}</p>`}
</header>
${content}
</main>
</div>
</div>
</body>`;
  return document(title, head, body);
}

function banners(ctx: PageContext): SafeHtml {
  return html`<div class="banners">${ctx.publishingEnabled
    ? html`<div class="banner red" role="alert"><strong>Publishing: ENABLED.</strong> An approved post can go out now. Set it back to DISABLED in <a href="/settings">Settings</a> when you are done.</div>`
    : ''}${ctx.bufferBudgetLow
    ? html`<div class="banner amber" role="status"><strong>Buffer API budget low.</strong> Probes and stages are paused so the rest is kept for publishing.</div>`
    : ''}${ctx.secretsReady
    ? ''
    : html`<div class="banner amber" role="status"><strong>Not configured.</strong> The master key is missing from Windows Credential Manager. Run <code>cph install</code>, then reconnect the platforms.</div>`}</div>`;
}

function soloPage(title: string, body: SafeHtml): SafeHtml {
  return document(
    title,
    html``,
    html`<body>
<div class="solo">
<main id="main" class="solo-card card">
<span class="brand">${BRAND}</span>
${body}
</main>
</div>
</body>`,
  );
}

/** The page every signed-out request lands on. */
export function signInPage(): SafeHtml {
  return soloPage(
    'Sign in',
    html`<h1>Sign in</h1>
<p>Run <code>cph dashboard</code>, or ask Claude to open the dashboard, to sign in.</p>
<p class="muted">Each sign-in link works once, for 60 seconds.</p>`,
  );
}

/** A full page for an error outside the signed-in layout (a spent login link, a refused request). */
export function errorPage(title: string, message: string): SafeHtml {
  return soloPage(
    title,
    html`<h1>${title}</h1>
<p>${message}</p>
<p class="muted">Run <code>cph dashboard</code>, or ask Claude to open the dashboard, to sign in.</p>`,
  );
}

/** A notice shown at the top of a card or a section after an action. */
export function notice(kind: 'ok' | 'warn' | 'error' | 'info', text: SafeHtml | string): SafeHtml {
  return html`<div class="notice ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${text}</div>`;
}

/** An empty page or section: what is missing and one line on how to fill it. */
export function emptyState(title: string, line: SafeHtml | string, icon: IconName = 'inbox'): SafeHtml {
  return html`<div class="empty">${ICONS[icon]}<p class="empty-title">${title}</p><p>${line}</p></div>`;
}

/** Health state to CSS colour class (spec 4.4). */
export function healthClass(state: string): string {
  switch (state) {
    case 'connected':
      return 'green';
    case 'expiring':
      return 'amber';
    case 'needs_reconnect':
      return 'red';
    case 'manual_only':
      return 'blue';
    default:
      return 'grey';
  }
}

/** Draft status to CSS colour class: green when out, red when it needs a human, amber in flight. */
export function statusClass(status: string): string {
  switch (status) {
    case 'published':
    case 'handed_off':
      return 'green';
    case 'unknown':
    case 'failed':
    case 'held':
    case 'source_changed':
      return 'red';
    case 'pending_approval':
    case 'approved':
    case 'scheduled':
    case 'publishing':
      return 'amber';
    case 'staged':
      return 'blue';
    default:
      return 'grey';
  }
}

const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  devto: 'dev.to',
  linkedin: 'LinkedIn',
  x: 'X',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  hashnode: 'Hashnode',
  medium: 'Medium',
  substack: 'Substack',
  reddit: 'Reddit',
  youtube: 'YouTube',
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

const PLATFORM_MARKS: Readonly<Record<string, string>> = { devto: 'DEV', linkedin: 'in', medium: 'M', substack: 'S', x: 'X' };

/** The square platform mark next to a card title (decorative: the label is always written out too). */
export function platformBadge(platform: string): SafeHtml {
  const mark = PLATFORM_MARKS[platform] ?? platformLabel(platform).slice(0, 2);
  return html`<span class="platform-badge ${platform}" aria-hidden="true">${mark}</span>`;
}

const ROUTE_LABELS: Readonly<Record<string, string>> = { direct: 'direct API', buffer: 'via Buffer', assist: 'by hand (assist)' };

export function routeLabel(route: string): string {
  return ROUTE_LABELS[route] ?? route;
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Served at /static/dashboard.js. The approve buttons stay disabled until every checklist box on
 * their card is ticked (the server checks again), with a running "n of m ticked" count; j / k move
 * between cards, a = Approve & publish. After the Publishing switch swaps in, the status bar follows.
 */
export const DASHBOARD_JS = `(function () {
  'use strict';
  function sync() {
    document.querySelectorAll('form[data-approve-form]').forEach(function (form) {
      var boxes = form.querySelectorAll('input[name="checked"]');
      var ticked = 0;
      boxes.forEach(function (box) { if (box.checked) ticked++; });
      var ok = ticked === boxes.length;
      form.setAttribute('data-ready', ok ? 'true' : 'false');
      form.querySelectorAll('button[data-approve]').forEach(function (button) { button.disabled = !ok; });
      var progress = form.querySelector('[data-checklist-progress]');
      if (progress) progress.textContent = ok ? 'All ' + boxes.length + ' ticked, ready' : ticked + ' of ' + boxes.length + ' ticked';
    });
  }
  function syncPublishing() {
    var section = document.getElementById('publishing');
    var flag = document.querySelector('[data-status-publishing]');
    if (!section || !flag || !section.hasAttribute('data-publishing')) return;
    var on = section.getAttribute('data-publishing') === 'on';
    flag.classList.toggle('on', on);
    flag.classList.toggle('off', !on);
    flag.textContent = on ? 'ENABLED' : 'DISABLED';
  }
  document.addEventListener('change', function (e) {
    if (e.target && e.target.closest && e.target.closest('form[data-approve-form]')) sync();
  });
  document.addEventListener('DOMContentLoaded', sync);
  document.addEventListener('htmx:load', sync);
  document.addEventListener('htmx:afterSettle', syncPublishing);

  var current = -1;
  function cards() { return Array.prototype.slice.call(document.querySelectorAll('[data-approval-card]')); }
  function focusCard(i) {
    var list = cards();
    if (list.length === 0) return;
    current = Math.max(0, Math.min(list.length - 1, i));
    list.forEach(function (card, n) { card.classList.toggle('focused', n === current); });
    list[current].scrollIntoView({ block: 'nearest' });
  }
  function typing(t) {
    if (!t) return false;
    if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    return t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'radio';
  }
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    if (e.key === 'j') { focusCard(current + 1); e.preventDefault(); }
    else if (e.key === 'k') { focusCard(current - 1); e.preventDefault(); }
    else if (e.key === 'a') {
      var card = cards()[current < 0 ? 0 : current];
      var button = card && card.querySelector('button[data-approve][data-primary]');
      if (button && !button.disabled) { button.click(); e.preventDefault(); }
    }
  });
})();
`;

import type { Draft } from '@cph/core';
import type { Approval } from '../../db/repos.js';
import { approvalTag, payloadPreview } from '../../gate/approval-gate.js';
import type { BudgetSnapshot } from '../../services/api-budget.js';
import { renderPayload } from './draft.js';
import { html, type SafeHtml } from './html.js';
import { ICONS } from './icons.js';
import { csrfField, emptyState, formatUsd, platformBadge, platformLabel, routeLabel, statusClass } from './layout.js';

export interface ApprovalCardView {
  csrf: string;
  approval: Approval;
  draft: Draft;
  /** What the approval stands at now: pending, approved, published, denied, expired, ... */
  state: string;
  /** The "Verify before publishing" checklist, or undefined when the post cannot be read. */
  checklist?: string[];
  /** Buffer route: the mapped LinkedIn channel's name. */
  channelName?: string;
  costUsd: number;
  /** Buffer route: what is left of the API budget. */
  budget?: BudgetSnapshot;
  notice?: SafeHtml;
  /** Click mode: the click is the confirmation (no Windows Hello). */
  click?: boolean;
}

const cardId = (approvalId: string): string => `approval-${approvalId}`;

/** The primary button: Approve & schedule for a scheduled draft, Approve & hand off on an assist route. */
function primaryButton(draft: Draft): { action: string; label: string } {
  if (draft.scheduledAt !== undefined) return { action: 'schedule', label: 'Approve & schedule' };
  if (draft.route === 'assist') return { action: 'publish', label: 'Approve & hand off' };
  return { action: 'publish', label: 'Approve & publish' };
}

function facts(view: ApprovalCardView): SafeHtml {
  const { approval, draft, budget } = view;
  return html`<dl class="facts">
<dt>Platform</dt><dd>${platformLabel(draft.platform)}</dd>
<dt>Account</dt><dd>${draft.account}</dd>
<dt>Route</dt><dd>${routeLabel(draft.route)}${draft.route === 'buffer' ? html`, channel <strong>${view.channelName ?? 'none mapped'}</strong>` : ''}</dd>
<dt>Cost</dt><dd>${formatUsd(view.costUsd)}</dd>
${budget === undefined
  ? ''
  : html`<dt>Buffer API left</dt><dd>${budget.d1.remaining} of ${budget.d1.limit} (24 h) · ${budget.d30.remaining} of ${budget.d30.limit} (30 d)</dd>`}
<dt>Not before</dt><dd>${draft.notBefore ?? 'none'}</dd>
${draft.scheduledAt === undefined ? '' : html`<dt>Scheduled for</dt><dd>${draft.scheduledAt}</dd>`}
<dt>Expires</dt><dd>${approval.expiresAt}</dd>
<dt>Hash</dt><dd><code>${approval.payloadSha256}</code></dd>
</dl>`;
}

/** Approval state to CSS colour class. */
function approvalStateClass(state: string): string {
  if (state === 'approved' || state === 'published' || state === 'scheduled') return 'green';
  if (state === 'pending') return 'amber';
  if (state === 'unknown' || state === 'failed') return 'red';
  return 'grey';
}

/** One approval card. Pending: checklist and buttons. Anything else: its state and the last notice. */
export function approvalCard(view: ApprovalCardView): SafeHtml {
  const { approval, draft } = view;
  const id = cardId(approval.id);
  const pending = view.state === 'pending';
  const primary = primaryButton(draft);
  const askable = pending && view.checklist !== undefined;
  const tag = approvalTag(approval.payloadSha256);
  return html`<article class="card approval" id="${id}" data-approval-card data-approval-id="${approval.id}" data-state="${view.state}">
${view.notice ?? ''}
<header class="approval-head">
${platformBadge(draft.platform)}
<div class="approval-title">
<p class="eyebrow">${platformLabel(draft.platform)} · ${routeLabel(draft.route)}</p>
<h2>${platformLabel(draft.platform)} post for <a href="/drafts/${draft.id}">${draft.slug}</a></h2>
</div>
${askable
  ? html`<div class="tag-box"><span class="label">Approval tag</span><strong class="tag" data-approval-tag>${tag}</strong></div>`
  : html`<p class="approval-state"><span class="state ${approvalStateClass(view.state)}">${view.state}</span></p>`}
</header>
<div class="approval-body">
<section class="approval-preview">
<h3>Exactly what will be sent</h3>
${renderPayload(draft, { author: view.channelName ?? draft.account })}
</section>
<aside class="approval-facts" aria-label="Details">
${facts(view)}
</aside>
</div>
${!pending
  ? ''
  : view.checklist === undefined
    ? html`<div class="approval-form"><p class="notice error">The post can no longer be read, so this approval cannot be given. Sync the content and ask for a new approval.</p></div>`
    : html`<form data-approve-form class="approval-form" hx-post="/approvals/${approval.id}/approve" hx-target="#${id}" hx-swap="outerHTML" hx-indicator="#hello-${approval.id}" hx-sync="this:drop" method="post" action="/approvals/${approval.id}/approve">
${csrfField(view.csrf)}
<div class="checklist-head"><h3>Verify before publishing</h3><span class="progress" data-checklist-progress aria-live="polite">0 of ${view.checklist.length} ticked</span></div>
<ul class="checklist">${view.checklist.map((item) => html`<li><label><input type="checkbox" name="checked" value="${item}"> <span>${item}</span></label></li>`)}</ul>
${view.click === true
  ? html`<p class="tagline">Approval <strong class="tag-inline">${tag}</strong> <q>${payloadPreview(draft.payload)}</q>. Your click is the confirmation: approve only if this is what you want sent.</p>`
  : html`<p class="tagline">Windows Hello will name this approval <strong class="tag-inline">${tag}</strong> <q>${payloadPreview(draft.payload)}</q>. Approve only if the Hello prompt shows the same tag.</p>`}
<div class="actions">
<button type="submit" name="action" value="${primary.action}" class="primary" data-approve data-primary disabled>${primary.label}</button>
<button type="submit" name="action" value="only" data-approve disabled>Approve only</button>
<button type="button" class="danger" hx-post="/approvals/${approval.id}/deny" hx-target="#${id}" hx-swap="outerHTML" hx-indicator="#deny-${approval.id}">Deny</button>
<span id="hello-${approval.id}" class="htmx-indicator">${view.click === true ? 'Approving…' : 'Waiting for Windows Hello…'}</span>
<span id="deny-${approval.id}" class="htmx-indicator muted">Denying…</span>
</div>
<p class="approve-hint muted">Tick every box to unlock approving. ${view.click === true ? 'Approving takes one click.' : 'Approving asks for Windows Hello.'} <kbd>j</kbd>/<kbd>k</kbd> move between cards, <kbd>a</kbd> = ${primary.label}.</p>
</form>`}
</article>`;
}

// ---- red cards -------------------------------------------------------------------------------------

export type RedCardKind = 'unknown' | 'failed' | 'stage_failed' | 'cancel_failed' | 'remote_cancelled';

export interface RedCardView {
  csrf: string;
  kind: RedCardKind;
  draft: Draft;
  /** Why (a redacted failure reason or audit message). */
  reason?: string;
  /** Where to delete a platform-held post by hand. */
  manualUrl?: string;
  notice?: SafeHtml;
}

const RED_TITLES: Record<RedCardKind, string> = {
  unknown: 'Publish result unknown',
  failed: 'Did not go through',
  stage_failed: 'Stage did not land as a draft',
  cancel_failed: 'Scheduled post still on the platform: cancel it by hand',
  remote_cancelled: 'Remote scheduled post cancelled, re-approve',
};

/** A red card at the top of /approvals: something needs the owner before anything else happens. */
export function redCard(view: RedCardView): SafeHtml {
  const d = view.draft;
  const id = `red-${d.id}`;
  const target = html`hx-target="#${id}" hx-swap="outerHTML"`;
  let actions: SafeHtml = html``;
  if (view.kind === 'unknown') {
    actions = html`<div class="actions">
<button type="button" hx-post="/drafts/${d.id}/check" ${target} hx-indicator="#check-${d.id}">Check on platform</button>
<span id="check-${d.id}" class="htmx-indicator muted">Asking the platform…</span>
</div>
<form class="form-block" hx-post="/drafts/${d.id}/resolve" ${target} hx-indicator="#resolve-${d.id}" method="post" action="/drafts/${d.id}/resolve">
${csrfField(view.csrf)}
<label for="url-${d.id}">Post URL (optional, when it is live)</label>
<input id="url-${d.id}" type="url" name="remoteUrl" autocomplete="off" placeholder="https://">
<div class="actions">
<button type="submit" name="outcome" value="published">Mark as posted</button>
<button type="submit" name="outcome" value="failed">Mark as not posted</button>
<span id="resolve-${d.id}" class="htmx-indicator">Waiting for Windows Hello…</span>
</div>
</form>`;
  } else if (view.kind === 'cancel_failed') {
    actions = html`${view.manualUrl === undefined ? '' : html`<p><a href="${view.manualUrl}" target="_blank" rel="noopener noreferrer">Open the platform and delete the scheduled post</a></p>`}
<div class="actions">
<button type="button" class="primary" hx-post="/drafts/${d.id}/confirm-cancelled" ${target} hx-indicator="#confirm-${d.id}">I deleted it</button>
<span id="confirm-${d.id}" class="htmx-indicator">Waiting for Windows Hello…</span>
</div>`;
  }
  return html`<article class="card red" id="${id}" data-red-card="${view.kind}">
${view.notice ?? ''}
<div class="red-head">${ICONS.alert}<div>
<h2>${RED_TITLES[view.kind]}</h2>
<p class="red-meta">${platformLabel(d.platform)} ${routeLabel(d.route)} · <a href="/drafts/${d.id}">${d.slug}</a> · <span class="state ${statusClass(d.status)}">${d.status}</span></p>
</div></div>
${view.reason === undefined ? '' : html`<p class="red-reason">${view.reason}</p>`}
${actions}
</article>`;
}

export interface ApprovalsPageView {
  red: RedCardView[];
  cards: ApprovalCardView[];
  /** Set on /approvals/:id: show only that approval. */
  single?: boolean;
}

/** /approvals: red cards first, then one card per pending approval. */
export function approvalsView(view: ApprovalsPageView): SafeHtml {
  const holds = view.red.length;
  const waiting = view.cards.length;
  const single = view.single === true;
  return html`${holds === 0
    ? ''
    : html`<section class="stack red-cards" aria-labelledby="holds-heading">
<div class="section-head"><h2 id="holds-heading">Needs you first</h2><span class="label">${holds} open</span></div>
${view.red.map(redCard)}
</section>`}
<section class="stack" id="approvals" aria-labelledby="approvals-heading">
<div class="section-head"><h2 id="approvals-heading">${single ? 'This approval' : 'Waiting for approval'}</h2>${single ? '' : html`<span class="label">${waiting} pending</span>`}</div>
${waiting > 0
  ? view.cards.map(approvalCard)
  : single
    ? emptyState('No such approval.', html`It may have expired or been decided already. <a href="/approvals">See every approval</a>.`)
    : emptyState('Nothing is waiting for approval.', 'When Claude asks to publish a draft, its card lands here with the exact text, a checklist and the approval tag.', 'check')}
</section>
${single ? html`<p><a href="/approvals">All approvals</a></p>` : ''}`;
}

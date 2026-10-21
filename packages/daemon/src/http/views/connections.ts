import type { ConnectionView } from '../../services/connections.js';
import { html, type SafeHtml } from './html.js';
import { healthClass, platformLabel, routeLabel } from './layout.js';

/** Where each connectable route's card lives. */
const CONNECT_PAGE: Readonly<Record<string, string>> = { 'devto/direct': '/connections/devto', 'linkedin/buffer': '/connections/buffer' };

/** Platforms with nothing to connect in Phase 0: shown as blue "manual" (spec 4.1 rule 3). */
const MANUAL: readonly { platform: string; text: string }[] = [
  { platform: 'medium', text: 'Nothing to connect. Medium posts go out by hand from your logged-in browser.' },
  { platform: 'substack', text: 'Nothing to connect. Substack posts go out by hand from your publication editor.' },
];

export function stateBadge(state: string): SafeHtml {
  const label = state === 'manual_only' ? 'manual' : state.replace(/_/g, ' ');
  return html`<span class="state ${healthClass(state)}">${label}</span>`;
}

function connectionCard(view: ConnectionView): SafeHtml {
  const page = CONNECT_PAGE[`${view.platform}/${view.route}`];
  const connected = view.state === 'connected';
  return html`<article class="card conn" data-platform="${view.platform}" data-route="${view.route}">
<h2>${platformLabel(view.platform)} <span class="muted">${routeLabel(view.route)}</span></h2>
<p>${stateBadge(view.state)}${view.active ? html` <span class="muted">active route</span>` : ''}</p>
<dl class="facts">
${view.who === undefined ? '' : html`<dt>Connected as</dt><dd>${view.who}</dd>`}
${view.detail === undefined ? '' : html`<dt>Detail</dt><dd>${view.detail}</dd>`}
${view.nextAction === undefined ? '' : html`<dt>Next</dt><dd>${view.nextAction}</dd>`}
${view.checkedAt === undefined ? '' : html`<dt>Checked</dt><dd>${view.checkedAt}</dd>`}
</dl>
${page === undefined
  ? ''
  : html`<p class="next"><a class="button-link${connected ? '' : ' primary-link'}" href="${page}">${connected ? 'Manage' : 'Connect'} ${view.route === 'buffer' ? 'Buffer' : platformLabel(view.platform)}</a></p>`}
</article>`;
}

/** /connections: one card per registered route, plus the manual platforms. */
export function connectionsView(views: ConnectionView[]): SafeHtml {
  return html`<section class="cards">
${views.map(connectionCard)}
${MANUAL.map(
  (m) => html`<article class="card conn" data-platform="${m.platform}" data-route="manual">
<h2>${platformLabel(m.platform)}</h2>
<p>${stateBadge('manual_only')}</p>
<p class="muted">${m.text}</p>
</article>`,
)}
</section>`;
}

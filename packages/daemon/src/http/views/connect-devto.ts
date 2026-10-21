import type { ConnectionView } from '../../services/connections.js';
import { stateBadge } from './connections.js';
import { html, type SafeHtml } from './html.js';
import { csrfField } from './layout.js';

export const DEVTO_KEYS_URL = 'https://dev.to/settings/extensions';

export interface ConnectDevtoView {
  csrf: string;
  connection?: ConnectionView;
  /** The result of the last Test & Save. */
  notice?: SafeHtml;
}

/**
 * The dev.to connect card (U0-A). The key goes only into a password field with autocomplete off,
 * and the card never shows it back, not even masked.
 */
export function connectDevtoCard(view: ConnectDevtoView): SafeHtml {
  const c = view.connection;
  return html`<article class="card connect conn" id="connect-devto" data-platform="devto">
${view.notice ?? ''}
<h2>Connect dev.to</h2>
${c === undefined
  ? ''
  : html`<p class="state-line">${stateBadge(c.state)}${c.who === undefined ? '' : html` connected as <strong>${c.who}</strong>`}</p>
${c.nextAction === undefined || c.state === 'connected' ? '' : html`<p class="muted">${c.nextAction}</p>`}`}
<ol class="steps">
<li>Sign in at dev.to and open <a href="${DEVTO_KEYS_URL}" target="_blank" rel="noopener noreferrer">dev.to/settings/extensions</a>.</li>
<li>Scroll to "DEV Community API Keys".</li>
<li>Enter the description <code>content-powerhouse</code> and click <strong>Generate API Key</strong>.</li>
<li>Paste the key here. Never paste it into chat.</li>
</ol>
<form class="form-block" hx-post="/connections/devto" hx-target="#connect-devto" hx-swap="outerHTML" method="post" action="/connections/devto">
${csrfField(view.csrf)}
<label for="devto-key">dev.to API key</label>
<input id="devto-key" type="password" name="apiKey" autocomplete="off" spellcheck="false" required>
<div class="actions"><button type="submit" class="primary">Test &amp; Save</button><span class="htmx-indicator muted">Testing the key…</span></div>
</form>
</article>`;
}

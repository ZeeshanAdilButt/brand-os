import type { ConnectionView } from '../../services/connections.js';
import { stateBadge } from './connections.js';
import { html, type SafeHtml } from './html.js';
import { csrfField } from './layout.js';

export const BUFFER_SIGNUP_URL = 'https://buffer.com';
export const BUFFER_API_KEYS_URL = 'https://publish.buffer.com/settings/api';

/** A LinkedIn channel from Buffer's last channel list. */
export interface ChannelOption {
  id: string;
  name: string;
}

export interface ConnectBufferView {
  csrf: string;
  connection?: ConnectionView;
  channels: ChannelOption[];
  /** The mapped LinkedIn channel id from config. */
  mappedChannelId?: string;
  notice?: SafeHtml;
}

/**
 * The Buffer connect card (U0-B): four numbered steps, the paste field, then the LinkedIn channel
 * mapping. Changing the mapping needs Windows Hello (it changes where an approved post goes).
 */
export function connectBufferCard(view: ConnectBufferView): SafeHtml {
  const c = view.connection;
  return html`<article class="card connect conn" id="connect-buffer" data-platform="linkedin">
${view.notice ?? ''}
<h2>Connect Buffer (LinkedIn)</h2>
${c === undefined
  ? ''
  : html`<p class="state-line">${stateBadge(c.state)}${c.who === undefined ? '' : html` posting as <strong>${c.who}</strong>`}</p>
${c.detail === undefined ? '' : html`<p class="muted">${c.detail}</p>`}
${c.nextAction === undefined || c.state === 'connected' ? '' : html`<p class="muted">${c.nextAction}</p>`}`}
<ol class="steps">
<li>Sign up at <a href="${BUFFER_SIGNUP_URL}" target="_blank" rel="noopener noreferrer">buffer.com</a> on the <strong>Free</strong> plan (no card).</li>
<li>In Buffer, click <em>Connect channel</em>, choose <strong>LinkedIn, personal profile</strong>, and approve LinkedIn's screen.</li>
<li>Open <a href="${BUFFER_API_KEYS_URL}" target="_blank" rel="noopener noreferrer">publish.buffer.com/settings/api</a> and create an API key named <code>content-powerhouse</code> (Free allows one key).</li>
<li>Paste the key below, then pick the LinkedIn channel in the mapping list.</li>
</ol>
<p class="caution">Never add Buffer's own MCP to Claude, and keep Buffer's Claude integration off in claude.ai: it would let Claude post outside this approval gate.</p>
<form class="form-block" hx-post="/connections/buffer" hx-target="#connect-buffer" hx-swap="outerHTML" method="post" action="/connections/buffer">
${csrfField(view.csrf)}
<label for="buffer-key">Buffer API key</label>
<input id="buffer-key" type="password" name="apiKey" autocomplete="off" spellcheck="false" required>
<div class="actions"><button type="submit" class="primary">Test &amp; Save</button><span class="htmx-indicator muted">Testing the key…</span></div>
</form>
${view.channels.length === 0
  ? html`<p class="empty-line muted">The LinkedIn channel list appears here once Buffer is connected.</p>`
  : html`<form class="form-block" hx-post="/connections/buffer/channel" hx-target="#connect-buffer" hx-swap="outerHTML" hx-indicator="#buffer-hello" method="post" action="/connections/buffer/channel">
${csrfField(view.csrf)}
<label for="buffer-channel">LinkedIn channel</label>
<select id="buffer-channel" name="channelId">
${view.mappedChannelId === undefined ? html`<option value="" selected disabled>Choose a channel</option>` : ''}
${view.channels.map((ch) => html`<option value="${ch.id}"${ch.id === view.mappedChannelId ? html` selected` : ''}>${ch.name}</option>`)}
</select>
<div class="actions"><button type="submit">Save channel</button><span id="buffer-hello" class="htmx-indicator muted">Waiting for Windows Hello…</span></div>
<p class="muted">Changing the channel asks you to confirm (a click, or Windows Hello when that mode is on) and cancels every pending or approved LinkedIn approval.</p>
</form>`}
</article>`;
}

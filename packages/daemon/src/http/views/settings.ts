import { html, type SafeHtml } from './html.js';
import { csrfField, platformLabel } from './layout.js';

export interface SettingsView {
  csrf: string;
  publishingEnabled: boolean;
  /** platform -> dry run on. */
  dryRun: { platform: string; on: boolean }[];
  publishingNotice?: SafeHtml;
  dryRunNotice?: SafeHtml;
}

/** The Publishing section. Turning it ENABLED asks for Windows Hello; DISABLED never does. */
export function publishingSection(view: Pick<SettingsView, 'csrf' | 'publishingEnabled' | 'publishingNotice'>): SafeHtml {
  const on = view.publishingEnabled;
  return html`<article class="card switch-card" id="publishing" data-publishing="${on ? 'on' : 'off'}">
${view.publishingNotice ?? ''}
<h2>Publishing: ${on ? html`<span class="state red">ENABLED</span>` : html`<span class="state grey">DISABLED</span>`}</h2>
<p class="muted">${on
    ? 'An approved post can go out. Set it back to DISABLED when you are done.'
    : 'Nothing can go out, whatever is approved. Setting it to ENABLED asks you to confirm (a click, or Windows Hello when that mode is on).'}</p>
<form hx-post="/settings/publishing" hx-target="#publishing" hx-swap="outerHTML" hx-indicator="#publishing-hello" method="post" action="/settings/publishing">
${csrfField(view.csrf)}
<input type="hidden" name="enabled" value="${on ? 'false' : 'true'}">
<div class="actions">
<button type="submit" class="${on ? 'primary' : 'solid-danger'}">Set Publishing: ${on ? 'DISABLED' : 'ENABLED'}</button>
${on ? '' : html`<span id="publishing-hello" class="htmx-indicator">Waiting for Windows Hello…</span>`}
</div>
</form>
</article>`;
}

/** Per-platform dry run: render and log, send nothing. Turning it OFF asks for Windows Hello. */
export function dryRunSection(view: Pick<SettingsView, 'csrf' | 'dryRun' | 'dryRunNotice'>): SafeHtml {
  return html`<article class="card" id="dry-run">
${view.dryRunNotice ?? ''}
<h2>Dry run</h2>
<p class="muted">A platform in dry run renders and logs a publish but sends nothing. Turning dry run off asks for Windows Hello.</p>
${view.dryRun.length === 0
  ? html`<p class="muted">No platform has a dry-run switch yet.</p>`
  : html`<div class="scroll"><table class="dry-table"><tbody>${view.dryRun.map(
      (d) => html`<tr><td><strong>${platformLabel(d.platform)}</strong></td><td>${d.on ? html`<span class="state blue">dry run ON</span>` : html`<span class="state grey">dry run OFF</span>`}</td>
<td><form hx-post="/settings/dry-run/${d.platform}" hx-target="#dry-run" hx-swap="outerHTML" hx-indicator="#dry-hello-${d.platform}" method="post" action="/settings/dry-run/${d.platform}">
${csrfField(view.csrf)}<input type="hidden" name="enabled" value="${d.on ? 'false' : 'true'}">
<button type="submit">Turn dry run ${d.on ? 'OFF' : 'ON'}</button>
${d.on ? html`<span id="dry-hello-${d.platform}" class="htmx-indicator">Waiting for Windows Hello…</span>` : ''}
</form></td></tr>`,
    )}</tbody></table></div>`}
</article>`;
}

/** /settings. */
export function settingsView(view: SettingsView): SafeHtml {
  return html`<section class="stack">
${publishingSection(view)}
${dryRunSection(view)}
</section>`;
}

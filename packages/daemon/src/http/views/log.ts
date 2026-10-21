import { redactDetail } from '../../audit.js';
import type { AuditRow } from '../../db/repos.js';
import { html, type SafeHtml } from './html.js';
import { emptyState } from './layout.js';

/** /log: the audit log, newest first. Details are redacted once more on the way out. */
export function logView(rows: AuditRow[]): SafeHtml {
  if (rows.length === 0) return emptyState('The audit log is empty.', 'Sign-ins, drafts, approvals and publishes are recorded here as they happen.', 'log');
  return html`<div class="table-wrap"><div class="scroll"><table class="stacked">
<thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Platform</th><th>Draft</th><th>Detail</th></tr></thead>
<tbody>${rows.map(
    (r) => html`<tr>
<td class="time lead">${r.ts}</td><td data-label="Actor"><span class="actor">${r.actorChannel}</span></td><td data-label="Action"><span class="action-name">${r.action}</span></td><td data-label="Platform">${r.platform ?? ''}</td>
<td data-label="Draft">${r.draftId === undefined ? '' : html`<a class="mono" href="/drafts/${r.draftId}">${r.draftId.slice(0, 8)}</a>`}</td>
<td data-label="Detail" class="detail">${r.detail === undefined ? '' : html`<code>${JSON.stringify(redactDetail(r.detail))}</code>`}</td>
</tr>`,
  )}</tbody>
</table></div></div>`;
}

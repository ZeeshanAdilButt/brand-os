import type { Draft } from '@cph/core';
import { lintCounts } from './draft.js';
import { html, type SafeHtml } from './html.js';
import { emptyState, platformLabel, routeLabel, statusClass } from './layout.js';

/** /drafts: every draft, newest first. */
export function draftsList(drafts: Draft[]): SafeHtml {
  if (drafts.length === 0) {
    return emptyState('No drafts yet.', html`Ask Claude to draft a post, or run <code>cph plan &lt;slug&gt;</code>. Drafts show up here with their lint results.`, 'drafts');
  }
  return html`<div class="table-wrap"><div class="scroll"><table class="stacked">
<thead><tr><th>Post</th><th>Platform</th><th>Route</th><th>Status</th><th>Lint</th><th>Updated</th></tr></thead>
<tbody>${drafts.map(
    (d) => html`<tr><td class="lead"><a class="post-title" href="/drafts/${d.id}">${d.slug}</a></td><td data-label="Platform">${platformLabel(d.platform)}</td><td data-label="Route">${routeLabel(d.route)}</td><td data-label="Status"><span class="state ${statusClass(d.status)}">${d.status}</span></td><td data-label="Lint">${lintCounts(d.lint)}</td><td data-label="Updated" class="time">${d.updatedAt}</td></tr>`,
  )}</tbody>
</table></div></div>`;
}

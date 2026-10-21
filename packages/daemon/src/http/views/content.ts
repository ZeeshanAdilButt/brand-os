import type { Draft } from '@cph/core';
import type { ContentRow } from '../../db/repos.js';
import { html, type SafeHtml } from './html.js';
import { emptyState, platformLabel, statusClass } from './layout.js';

/** The platforms Phase 0 drafts for: the matrix columns. */
export const MATRIX_PLATFORMS = ['devto', 'linkedin'] as const;

export interface ContentMatrixRow {
  content: ContentRow;
  /** The newest draft per platform. */
  latest: Partial<Record<string, Draft>>;
}

function liveCheck(row: ContentRow): SafeHtml {
  if (!row.published) return html`<span class="state grey">not published</span> <span class="live-note">frontmatter says published: false</span>`;
  if (row.canonicalLiveAt === undefined) return html`<span class="state amber">not live yet</span> <span class="live-note">the live check has not passed</span>`;
  return html`<span class="state green">live</span> <span class="live-note">since ${row.canonicalLiveAt}</span>`;
}

function cell(draft: Draft | undefined): SafeHtml {
  if (draft === undefined) return html`<span class="muted">no draft</span>`;
  return html`<span class="pill ${statusClass(draft.status)}"><a href="/drafts/${draft.id}">${draft.status}</a></span>`;
}

/** /content: the posts × platforms matrix, with each post's live-check state. */
export function contentMatrix(rows: ContentMatrixRow[]): SafeHtml {
  if (rows.length === 0) {
    return emptyState('No posts synced yet.', html`Run <code>cph sync</code> or ask Claude to sync the content. Each post from the site gets a row here.`, 'content');
  }
  return html`<div class="table-wrap"><div class="scroll"><table class="stacked">
<thead><tr><th>Post</th><th>Live check</th>${MATRIX_PLATFORMS.map((p) => html`<th>${platformLabel(p)}</th>`)}</tr></thead>
<tbody>${rows.map(
    (r) => html`<tr>
<td class="lead"><span class="post-title">${r.content.title}</span><span class="post-meta">${r.content.slug} · ${r.content.date}${r.content.dirty ? ' · uncommitted changes' : ''}</span></td>
<td data-label="Live check"><div class="cell">${liveCheck(r.content)}</div></td>
${MATRIX_PLATFORMS.map((p) => html`<td data-label="${platformLabel(p)}">${cell(r.latest[p])}</td>`)}
</tr>`,
  )}</tbody>
</table></div></div>`;
}

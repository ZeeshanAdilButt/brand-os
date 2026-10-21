import { formatTable, type CliContext } from '../context.js';
import { runGuarded } from './shared.js';

export interface DraftListOptions {
  slug?: string;
  platform?: string;
  status?: string;
}

export function runDraftsList(ctx: CliContext, options: DraftListOptions): Promise<number> {
  return runGuarded(ctx, async () => {
    const filter: DraftListOptions = {};
    if (options.slug !== undefined) filter.slug = options.slug;
    if (options.platform !== undefined) filter.platform = options.platform;
    if (options.status !== undefined) filter.status = options.status;
    const { drafts } = await ctx.client().listDrafts(filter);
    if (drafts.length === 0) {
      ctx.out('No drafts.');
      return 0;
    }
    for (const line of formatTable(
      ['id', 'slug', 'platform', 'route', 'status'],
      drafts.map((d) => [d.id, d.slug, d.platform, d.route, d.status]),
    )) {
      ctx.out(line);
    }
    return 0;
  });
}

export function runDraftsShow(ctx: CliContext, id: string): Promise<number> {
  return runGuarded(ctx, async () => {
    const d = await ctx.client().getDraft(id);
    ctx.out(`id:        ${d.id}`);
    ctx.out(`slug:      ${d.slug}`);
    ctx.out(`platform:  ${d.platform} (${d.route}, ${d.kind}, account ${d.account})`);
    ctx.out(`status:    ${d.status}`);
    ctx.out(`authorship: ${d.authorship}`);
    ctx.out(`hash:      ${d.payloadSha256}`);
    if (d.remoteRef !== undefined) ctx.out(`remote:    ${d.remoteRef}`);
    if (d.failureReason !== undefined) ctx.out(`failure:   ${d.failureReason}`);
    for (const l of d.lint) ctx.out(`lint ${l.severity}: ${l.rule}: ${l.message}`);
    ctx.out('payload:');
    ctx.out(JSON.stringify(d.payload, null, 2));
    return 0;
  });
}

export function runDraftsStage(ctx: CliContext, id: string): Promise<number> {
  return runGuarded(ctx, async () => {
    const result = await ctx.client().stageDraft(id);
    ctx.out(`Staged as a private draft on the platform (remote id ${result.remoteId}).`);
    if (result.previewUrl !== undefined) ctx.out(`Preview: ${result.previewUrl}`);
    ctx.out('Nothing is public. Publishing needs your approval in the dashboard.');
    return 0;
  });
}

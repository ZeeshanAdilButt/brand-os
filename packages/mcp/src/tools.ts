/**
 * The MCP tool surface (T0.20). Exactly these tools and no others: nothing here can approve or deny
 * an approval, change a setting, toggle publishing, map a channel, confirm a remote cancel or resolve
 * a draft by hand. Those are dashboard-only or CLI-only. The one exception is `approve_in_chat`: it
 * records an approval only after the owner himself answered the prompt Claude Code shows (an MCP
 * elicitation, which the model cannot fill in), with every box ticked and Approve chosen.
 *
 * Error texts, log entries, connection status and the approval and dashboard results go through the
 * daemon's `redact` before they leave this process. Post and draft content (payloads, frontmatter,
 * notes, lint) is returned as it is: it never holds a secret, and redacting it would corrupt git SHAs,
 * long identifiers and ordinary prose that Claude has to read and copy back exactly. No result
 * carries a token, a login nonce or a payload hash.
 */
import { DaemonApiError, DaemonUnavailableError, type DaemonApi } from '@cph/client';
import { DashboardPage, DRAFT_PLATFORMS, DRAFT_STATUSES, PLATFORM_IDS, type DraftResponse } from '@cph/daemon/api';
import { redact } from '@cph/daemon/redact';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitResultSchema, type CallToolResult, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const DAEMON_DOWN_TEXT = 'Daemon not running: run `cph daemon start`';
export const NOT_SET_UP_TEXT = "content-powerhouse isn't set up yet: run `cph install`";
export const PUBLISHING_DISABLED_TEXT =
  'Publishing is DISABLED. The owner can enable it in Dashboard → Settings (he confirms there).';
/** The 503 codes that mean "not installed yet". Any other 503 (SECRET_UNREADABLE, ...) says what it is. */
const NOT_SET_UP_CODES: ReadonlySet<string> = new Set(['NOT_CONFIGURED']);
const TIMEOUT_TEXT =
  'The daemon did not answer in time. Do not retry blindly: check list_drafts or get_approval_status first to see whether the action went through.';

/** The polling contract, verbatim from the brief. */
export function approvalInstructions(approveUrl: string): string {
  return `Ask the owner to approve at ${approveUrl}. Then call get_approval_status every 15 seconds for up to 10 minutes. Stop when the status is published (report the URL), approved (call publish now), denied or expired. After 10 minutes, stop and say the approval is still waiting.`;
}

/** Turns anything a tool can throw into the one line Claude sees. */
export function errorText(error: unknown): string {
  if (error instanceof DaemonUnavailableError) return error.timedOut ? TIMEOUT_TEXT : DAEMON_DOWN_TEXT;
  if (error instanceof DaemonApiError) {
    if (error.status === 503 && NOT_SET_UP_CODES.has(error.code)) return NOT_SET_UP_TEXT;
    if (error.status === 409 && error.code === 'PUBLISHING_DISABLED') return PUBLISHING_DISABLED_TEXT;
    return `${error.code}: ${error.message}`;
  }
  return `Unexpected error: ${error instanceof Error ? error.message : 'unknown failure'}`;
}

type Outcome = string | { text: string; isError: true };

/** How a successful result is returned: `redacted` (the default), or `content` (post and draft text, verbatim). */
export type ResultKind = 'redacted' | 'content';

/** One text result. An error is always redacted; a success is redacted unless it is post or draft content. */
export function toResult(text: string, isError = false, kind: ResultKind = 'redacted'): CallToolResult {
  const content = [{ type: 'text' as const, text: isError || kind === 'redacted' ? redact(text) : text }];
  return isError ? { content, isError: true } : { content };
}

/** Runs one tool body: success text, a flagged outcome, or a mapped error. Never throws. */
async function run(body: () => Promise<Outcome>, kind: ResultKind = 'redacted'): Promise<CallToolResult> {
  try {
    const outcome = await body();
    return typeof outcome === 'string' ? toResult(outcome, false, kind) : toResult(outcome.text, true);
  } catch (error) {
    return toResult(errorText(error), true);
  }
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** A draft as Claude sees it: everything but the approval hash. */
export function draftView(d: DraftResponse): Record<string, unknown> {
  const { payloadSha256: _hash, ...rest } = d;
  return rest;
}

function draftText(d: DraftResponse): string {
  const errors = d.lint.filter((l) => l.severity === 'error').length;
  const hint =
    errors > 0
      ? `\n\n${errors} lint error(s). Fix every lint error with update_draft before request_approval.`
      : '\n\nNo lint errors.';
  return json(draftView(d)) + hint;
}

export function approvalText(a: {
  approvalId: string;
  draftId: string;
  status: string;
  mode: string;
  expiresAt: string;
  remoteUrl?: string | undefined;
}): string {
  const head = `Approval ${a.approvalId} for draft ${a.draftId}: status ${a.status}.`;
  switch (a.status) {
    case 'pending':
      return `${head} the owner has not decided yet. Keep polling every 15 seconds, up to 10 minutes in total.`;
    case 'approved':
      return a.mode === 'approve_only'
        ? `${head} the owner approved. Call publish now with this draft_id and approval_id (the approval expires at ${a.expiresAt}).`
        : `${head} Approved in the dashboard (mode ${a.mode}). The daemon sends it itself: do not call publish. Keep polling.`;
    case 'publishing':
      return `${head} The send is in flight. Keep polling; do not call publish again.`;
    case 'published':
      return a.remoteUrl === undefined ? `${head} The platform returned no URL.` : `${head} URL: ${a.remoteUrl}`;
    case 'handed_off':
      return `${head} Prepared for manual posting. Nothing is confirmed until the owner posts it and you call record_publication with the URL.`;
    case 'denied':
      return `${head} the owner denied it. Nothing was posted. Do not request another approval unless he asks.`;
    case 'expired':
      return `${head} The approval expired before it was used. Nothing was posted. Ask the owner whether to request a new one.`;
    case 'invalidated':
      return `${head} The draft or its source changed after approval, so the approval is void. Nothing was posted. Review the draft, and call request_approval again only if the owner wants that.`;
    case 'cancelled':
      return `${head} The approval was cancelled. Nothing was posted.`;
    case 'failed':
      return `${head} The send failed. Do not retry automatically: tell the owner and read get_publish_log.`;
    case 'unknown':
      return `${head} The outcome is unknown. Do not retry: call check_on_platform, then tell the owner.`;
    default:
      return head;
  }
}

export const NO_ELICITATION_TEXT = "Your Claude client can't show approval prompts; approve in the dashboard instead.";
export const NOT_APPROVED_TEXT = 'Not approved.';
/** The prompt can sit open while the owner reads the payload. */
const ELICIT_TIMEOUT_MS = 10 * 60_000;

/** The shape of the prompt's form fields (JSON Schema primitives, as MCP elicitation allows). */
type FormSchema = {
  type: 'object';
  properties: Record<string, { type: 'boolean'; title: string; default: boolean } | { type: 'string'; title: string; enum: string[]; default: string }>;
  required: string[];
};

/** Shows a form-mode elicitation. Throws NoElicitation when the client cannot show one. */
class NoElicitation extends Error {}
async function elicit(server: McpServer, message: string, requestedSchema: FormSchema): Promise<ElicitResult> {
  const capability = server.server.getClientCapabilities()?.elicitation;
  // No capability, or URL mode only: no form. An empty capability object means form mode (MCP spec).
  if (capability === undefined || (capability.form === undefined && capability.url !== undefined)) throw new NoElicitation();
  const options = { timeout: ELICIT_TIMEOUT_MS };
  if (capability.form !== undefined) return server.server.elicitInput({ mode: 'form', message, requestedSchema }, options);
  return server.server.request({ method: 'elicitation/create', params: { mode: 'form', message, requestedSchema } }, ElicitResultSchema, options);
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const PLATFORM_READ = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const PRIVATE_STAGE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const SEND = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

const slugField = z.string().min(1).max(200).describe('The post slug, for example "how-queues-hide-latency".');
const draftIdField = z.string().min(1).max(128).describe('The draft id returned by create_draft.');
const approvalIdField = z.string().min(1).max(128).describe('The approval id returned by request_approval.');
const draftPlatform = z.enum(DRAFT_PLATFORMS).describe('The platform to draft for.');

export function registerTools(server: McpServer, client: DaemonApi): void {
  server.registerTool(
    'sync_content',
    {
      description:
        'Re-reads the site repo and updates the local content index. Reports changed posts and approvals voided by a source change.',
      annotations: READ_ONLY,
    },
    () => run(async () => json(await client.sync()), 'content'),
  );

  server.registerTool(
    'list_content',
    { description: 'Lists posts with title, date, publish state and the drafts that exist for each.', annotations: READ_ONLY },
    () =>
      run(async () => {
        const { content } = await client.listContent();
        return json(
          content.map((c) => ({
            slug: c.slug,
            title: c.title,
            date: c.date,
            published: c.published,
            dirty: c.dirty,
            canonicalUrl: c.canonicalUrl,
            drafts: c.drafts,
          })),
        );
      }, 'content'),
  );

  server.registerTool(
    'get_content',
    {
      description:
        'Returns one post: frontmatter, the publishing notes (excerpt, OG text, key entities, fact labels) and its drafts.',
      inputSchema: { slug: slugField },
      annotations: READ_ONLY,
    },
    ({ slug }) =>
      run(async () => {
        const { repoCommit: _commit, ...detail } = await client.getContent(slug);
        return json(detail);
      }, 'content'),
  );

  server.registerTool(
    'list_connections',
    {
      description: 'Shows which platforms are connected, expiring or need reconnecting. Never shows credentials.',
      annotations: READ_ONLY,
    },
    () => run(async () => json(await client.listConnections())),
  );

  server.registerTool(
    'preview_adaptation',
    {
      description:
        'Returns the skeleton payload and lint results the transform would produce for this post and platform. Creates nothing.',
      inputSchema: { slug: slugField, platform: draftPlatform },
      annotations: READ_ONLY,
    },
    ({ slug, platform }) => run(async () => json(await client.preview(slug, platform)), 'content'),
  );

  server.registerTool(
    'list_drafts',
    {
      description: 'Lists drafts, optionally filtered by slug, platform or status.',
      inputSchema: {
        slug: slugField.optional(),
        platform: z.enum(PLATFORM_IDS).optional(),
        status: z.enum(DRAFT_STATUSES).optional(),
      },
      annotations: READ_ONLY,
    },
    ({ slug, platform, status }) =>
      run(async () => {
        const filter = {
          ...(slug !== undefined ? { slug } : {}),
          ...(platform !== undefined ? { platform } : {}),
          ...(status !== undefined ? { status } : {}),
        };
        const { drafts } = await client.listDrafts(filter);
        return json(drafts.map(draftView));
      }, 'content'),
  );

  server.registerTool(
    'get_approval_status',
    {
      description:
        'Reports the state of an approval and what to do next. Only a status of published means something was posted.',
      inputSchema: { approval_id: approvalIdField },
      annotations: READ_ONLY,
    },
    ({ approval_id }) => run(async () => approvalText(await client.getApproval(approval_id))),
  );

  server.registerTool(
    'get_publish_log',
    {
      description: 'Returns recent audit entries (approvals, publishes, failures), newest first.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
        draft_id: draftIdField.optional(),
      },
      annotations: READ_ONLY,
    },
    ({ limit, draft_id }) =>
      run(async () => {
        const filter = {
          ...(limit !== undefined ? { limit } : {}),
          ...(draft_id !== undefined ? { draftId: draft_id } : {}),
        };
        return json((await client.getLog(filter)).entries);
      }),
  );

  server.registerTool(
    'open_dashboard',
    {
      description:
        "Opens a dashboard page in the user's browser, signed in. Pages: connections, connections/<platform>, drafts/<id>, approvals, approvals/<id>, content, log. Returns only {opened, page}.",
      inputSchema: { page: DashboardPage.describe('For example "approvals" or "drafts/<draft id>".') },
      annotations: LOCAL_WRITE,
    },
    ({ page }) =>
      run(async () => {
        const { opened, page: openedPage } = await client.openDashboard(page);
        return json({ opened, page: openedPage });
      }),
  );

  server.registerTool(
    'connect_platform',
    {
      description:
        "Opens the signed-in connect page for this platform in the user's browser. Never ask the user for keys in chat.",
      inputSchema: { platform: z.enum([...PLATFORM_IDS, 'buffer'] as const) },
      annotations: LOCAL_WRITE,
    },
    ({ platform }) =>
      run(async () => {
        const { opened, page } = await client.openDashboard(`connections/${platform}`);
        return json({ opened, page });
      }),
  );

  server.registerTool(
    'create_draft',
    {
      description:
        'Creates a draft for a post and platform. Without payload it starts from the transform skeleton. The result lists lint errors: fix every one with update_draft before request_approval.',
      inputSchema: {
        slug: slugField,
        platform: draftPlatform,
        payload: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Fields to merge over the skeleton, for example {"text": "..."} for LinkedIn.'),
      },
      annotations: LOCAL_WRITE,
    },
    ({ slug, platform, payload }) =>
      run(async () => draftText(await client.createDraft({ slug, platform, ...(payload !== undefined ? { payload } : {}) })), 'content'),
  );

  server.registerTool(
    'update_draft',
    {
      description: 'Merges a patch into the draft payload. Any real change voids earlier approvals for this draft.',
      inputSchema: { draft_id: draftIdField, patch: z.record(z.string(), z.unknown()) },
      annotations: LOCAL_WRITE,
    },
    ({ draft_id, patch }) => run(async () => draftText(await client.updateDraft(draft_id, patch)), 'content'),
  );

  server.registerTool(
    'request_approval',
    {
      description:
        'Asks the owner to approve this draft. Returns the dashboard URL and how to wait. It does not block, and Claude cannot approve: only the owner can, in the dashboard or at the prompt approve_in_chat shows him.',
      inputSchema: { draft_id: draftIdField },
      annotations: LOCAL_WRITE,
    },
    ({ draft_id }) =>
      run(async () => {
        const res = await client.requestApproval(draft_id);
        return `${approvalInstructions(res.approveUrl)}\nApproval id: ${res.approvalId}`;
      }),
  );

  server.registerTool(
    'approve_in_chat',
    {
      description: 'Shows the user an approval prompt in Claude Code. Only the user can answer it. Never call this without the user asking to approve.',
      inputSchema: { approval_id: approvalIdField },
      annotations: LOCAL_WRITE,
    },
    ({ approval_id }) =>
      run(async (): Promise<Outcome> => {
        const card = await client.getApprovalCard(approval_id);
        if (card.status !== 'pending') {
          return { text: `Approval ${approval_id} is ${card.status}, so there is nothing to approve.`, isError: true };
        }
        const properties: FormSchema['properties'] = {};
        const boxes = card.checklist.map((item, index) => {
          const key = `check_${index + 1}`;
          properties[key] = { type: 'boolean', title: item, default: false };
          return key;
        });
        properties['decision'] = { type: 'string', title: 'Decision', enum: ['Approve', 'Cancel'], default: 'Cancel' };
        const message = [
          `Approve ${card.platform} via ${card.route} ${card.tag} for ${card.slug}?`,
          '',
          'This is exactly what will be sent:',
          '',
          card.payloadText,
          '',
          'Tick every box, then choose Approve.',
        ].join('\n');

        let answer: ElicitResult;
        try {
          answer = await elicit(server, message, { type: 'object', properties, required: [...boxes, 'decision'] });
        } catch (error) {
          if (error instanceof NoElicitation) return { text: NO_ELICITATION_TEXT, isError: true };
          throw error;
        }
        if (answer.action !== 'accept' || answer.content?.['decision'] !== 'Approve') return { text: NOT_APPROVED_TEXT, isError: true };
        if (card.checklist.length === 0 || !boxes.every((key) => answer.content?.[key] === true)) {
          return { text: `${NOT_APPROVED_TEXT} Every box must be ticked.`, isError: true };
        }

        await client.approveInChat(approval_id, card.checklist);
        const next = card.route === 'assist' ? 'hand_off' : 'publish';
        return `The owner approved ${card.tag} in Claude Code (Approve only). Call ${next} now with draft_id ${card.draftId} and approval_id ${approval_id}; the approval expires after 30 minutes.`;
      }),
  );

  server.registerTool(
    'record_publication',
    {
      description: 'Records the public URL after the owner posted a handed-off draft himself.',
      inputSchema: { draft_id: draftIdField, url: z.string().min(1).max(2000).describe('The public URL of the post.') },
      annotations: LOCAL_WRITE,
    },
    ({ draft_id, url }) => run(async () => draftText((await client.recordPublication(draft_id, url)).draft), 'content'),
  );

  server.registerTool(
    'check_on_platform',
    {
      description:
        'Asks the platform whether an in-doubt send actually went out, and updates the draft status. Read-only on the platform.',
      inputSchema: { draft_id: draftIdField },
      annotations: PLATFORM_READ,
    },
    ({ draft_id }) =>
      run(async () => {
        const { outcome } = await client.checkDraft(draft_id);
        return `Platform check for draft ${draft_id}: ${outcome}.`;
      }),
  );

  server.registerTool(
    'stage_remote_draft',
    {
      description:
        'Stages the draft on the platform (dev.to draft or Buffer draft). It creates a PRIVATE draft only and never publishes.',
      inputSchema: { draft_id: draftIdField },
      annotations: PRIVATE_STAGE,
    },
    ({ draft_id }) =>
      run(async () => {
        const res = await client.stageDraft(draft_id);
        const preview = res.previewUrl === undefined ? '' : ` Preview: ${res.previewUrl}`;
        return `Staged as a PRIVATE draft (not public). Remote id: ${res.remoteId}.${preview}`;
      }),
  );

  server.registerTool(
    'publish',
    {
      description:
        'Secondary path. Normally the owner clicks Approve & publish in the dashboard and nothing more is needed. Use this only when the approval status is `approved`.',
      inputSchema: { draft_id: draftIdField, approval_id: approvalIdField },
      annotations: SEND,
    },
    ({ draft_id, approval_id }) =>
      run(async (): Promise<Outcome> => {
        const res = await client.publish(draft_id, approval_id);
        switch (res.status) {
          case 'published':
            return res.remoteUrl === undefined ? 'Published (the platform returned no URL).' : `Published: ${res.remoteUrl}`;
          case 'failed':
            return {
              text: `Publish failed: ${res.error ?? 'no detail'}. Do not retry automatically; tell the owner.`,
              isError: true,
            };
          case 'unknown':
            return {
              text: `Publish outcome unknown: ${res.error ?? 'no detail'}. Do not retry. Call check_on_platform, then tell the owner.`,
              isError: true,
            };
          case 'dry_run':
            return 'Dry run: nothing was posted.';
        }
      }),
  );

  server.registerTool(
    'hand_off',
    {
      description:
        'For platforms the owner posts by hand: copies the approved text to his clipboard and returns the link to open plus a checklist. Nothing is posted by this call.',
      inputSchema: { draft_id: draftIdField, approval_id: approvalIdField },
      annotations: SEND,
    },
    ({ draft_id, approval_id }) =>
      run(async () => {
        const res = await client.handOff(draft_id, approval_id);
        return [
          `The approved text is on the owner's clipboard. Nothing has been posted yet. Open: ${res.openUrl}`,
          'Checklist:',
          ...res.checklist.map((item) => `- ${item}`),
          'After the owner posts it, call record_publication with the public URL.',
        ].join('\n');
      }),
  );
}

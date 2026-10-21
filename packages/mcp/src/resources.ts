import type { DaemonApi } from '@cph/client';
import { redact } from '@cph/daemon/redact';
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { draftView, errorText } from './tools.js';

/**
 * Connection status and the approvals list are redacted; post, notes and draft content is returned as
 * it is (see tools.ts: redacting it corrupts SHAs and identifiers, and it holds no secrets).
 */
const asJson = (uri: URL, value: unknown, kind: 'redacted' | 'content' = 'redacted'): ReadResourceResult => {
  const text = JSON.stringify(value, null, 2);
  return { contents: [{ uri: uri.href, mimeType: 'application/json', text: kind === 'content' ? text : redact(text) }] };
};

function variable(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function guarded<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw new Error(redact(errorText(error)));
  }
}

export function registerResources(server: McpServer, client: DaemonApi): void {
  server.registerResource(
    'post',
    new ResourceTemplate('content://posts/{slug}', {
      list: async () => {
        try {
          const { content } = await client.listContent();
          return {
            resources: content.map((c) => ({ uri: `content://posts/${c.slug}`, name: c.title, mimeType: 'application/json' })),
          };
        } catch {
          return { resources: [] };
        }
      },
    }),
    { title: 'Post', description: 'A post: frontmatter, state and its drafts.' },
    (uri, vars) =>
      guarded(async () => {
        const { repoCommit: _commit, notes: _notes, ...post } = await client.getContent(variable(vars['slug']));
        return asJson(uri, post, 'content');
      }),
  );

  server.registerResource(
    'notes',
    new ResourceTemplate('content://notes/{slug}', { list: undefined }),
    {
      title: 'Publishing notes',
      description: 'The publishing package of a post: excerpt, OG text, key entities, fact labels.',
    },
    (uri, vars) =>
      guarded(async () => {
        const { notes } = await client.getContent(variable(vars['slug']));
        return asJson(uri, notes ?? { notes: null, message: 'This post has no publishing notes file.' }, 'content');
      }),
  );

  server.registerResource(
    'draft',
    new ResourceTemplate('drafts://{id}', {
      list: async () => {
        try {
          const { drafts } = await client.listDrafts({});
          return {
            resources: drafts.map((d) => ({
              uri: `drafts://${d.id}`,
              name: `${d.slug} (${d.platform}, ${d.status})`,
              mimeType: 'application/json',
            })),
          };
        } catch {
          return { resources: [] };
        }
      },
    }),
    { title: 'Draft', description: 'A draft with its payload and lint results.' },
    (uri, vars) => guarded(async () => asJson(uri, draftView(await client.getDraft(variable(vars['id']))), 'content')),
  );

  server.registerResource(
    'connections',
    'connections://status',
    { title: 'Connections', description: 'Connection state per platform. Never includes credentials.', mimeType: 'application/json' },
    (uri) => guarded(async () => asJson(uri, await client.listConnections())),
  );

  server.registerResource(
    'pending-approvals',
    'approvals://pending',
    { title: 'Pending approvals', description: 'Drafts waiting for the owner to approve.', mimeType: 'application/json' },
    (uri) =>
      guarded(async () => {
        const { drafts } = await client.listDrafts({ status: 'pending_approval' });
        return asJson(
          uri,
          drafts.map((d) => ({ draftId: d.id, slug: d.slug, platform: d.platform, status: d.status })),
        );
      }),
  );
}

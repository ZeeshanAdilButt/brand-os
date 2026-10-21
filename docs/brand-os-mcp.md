# The brand-os MCP server

`packages/brand-mcp` is a stdio MCP server named `brand-os`. It lets the owner's own Claude Code work with Brand OS articles, knowledge and the AI task inbox. It makes no model calls and holds no Claude login: it is a typed facade over the app's agent API (`/api/agent/*`).

Verified against Claude Code's MCP documentation on 2026-10-21 (see `INTEGRATIONS.md`, section 6).

## What it can do, and what it cannot

| Tool | Scope needed | What it does |
|---|---|---|
| `get_my_profile` | `read` | Profile and brand preferences |
| `search_knowledge` | `read` | Full-text search of knowledge items, with confidentiality and public-use flags |
| `list_articles` | `read` | List or search articles (no bodies) |
| `get_article` | `read` | One article with its Markdown and current revision |
| `create_article` | `write_articles` | A new draft; never published |
| `update_article` | `write_articles` | Save changes as a version; needs the revision you read |
| `list_ai_tasks` | `read` | Tasks in the inbox (pending and running by default) |
| `get_ai_task` | `read` | The task, its exact excerpt, allowed operations and their shapes |
| `submit_ai_task_result` | `ai_tasks` | Complete a pending or running task; the owner still accepts or rejects it |

There are **no tools for publishing, platform drafts, approvals, credentials, provider settings or other accounts**. Publishing and platform drafts arrive on Days 5 and 6, behind the existing approval gate; this server will not be where approval happens.

Read tools are annotated read-only. Write tools are annotated non-destructive (every article save is a restorable version), and none is open-world.

## How the identity works

The credential decides whose data a request touches. No tool takes an owner, user or account argument, the agent API ignores any such value, and a credential for one account cannot read, list, change or complete anything of another account even if it is given that account's ids (tested end to end with two accounts in `apps/web/test/mcp-flow.test.ts`).

A credential is created by the signed-in owner under **Settings > Agent access**:

- it has a name and a list of scopes (`read`, `write_articles`, `ai_tasks`);
- the secret is shown once and only its SHA-256 hash is stored;
- the list shows last use, and **Revoke** takes effect on the next request;
- requests are rate limited per credential, failed attempts are slowed, and every change an agent makes is in the owner's audit log with the credential it came from.

## Register it (a command you run yourself)

Build, then register at project scope with the credential in an environment variable:

```bash
pnpm build
export BRAND_OS_CREDENTIAL=<your-credential>
claude mcp add --scope project --transport stdio brand-os -- node "$(pwd)/packages/brand-mcp/dist/index.js"
```

`.mcp.json` should forward the variable (never a literal value, never committed):

```json
{
  "mcpServers": {
    "brand-os": {
      "type": "stdio",
      "command": "node",
      "args": ["./packages/brand-mcp/dist/index.js"],
      "env": {
        "BRAND_OS_CREDENTIAL": "${BRAND_OS_CREDENTIAL}",
        "BRAND_OS_URL": "${BRAND_OS_URL:-http://127.0.0.1:3100}"
      }
    }
  }
}
```

Settings the server reads:

| Variable | Meaning |
|---|---|
| `BRAND_OS_CREDENTIAL` | The credential (required). `--credential <value>` also works for a quick test, but a command line is visible to other programs, so prefer the variable. |
| `BRAND_OS_URL` | Where the app runs. Default `http://127.0.0.1:3100`. `--url <address>` also works. A hosted instance works the same way with its https address. |

Without a credential the server still starts, and every tool answers with the setup instruction instead of failing to connect.

On Windows prefer `node <path>` over `npx` (the shim has had quoting problems); check what Claude Code stored with `claude mcp get brand-os`.

## Working with AI tasks (the Claude Code hand-off)

1. In **Settings > AI** add the **Claude Code hand-off** provider (no key, no model).
2. In the article studio select text and choose an AI action with that provider (or use **Ask** and pick it under "Run with"). The task shows as "Waiting for Claude Code" with a copyable instruction: `In Claude Code: list my Brand OS AI tasks and complete task <id>`.
3. In Claude Code the model calls `list_ai_tasks`, `get_ai_task`, then `submit_ai_task_result`.
4. The result appears in the studio (live) as a diff or list. You accept or reject it. Accepting saves a version labelled as an AI change.

A result is checked by the same rules as an answer from any model: one to five operations from `replace_range`, `suggest_titles`, `review_notes`, `insert_after` and `outline`; only the operations that task kind allows; size limits; no HTML; and a `replace_range` must copy its `original` exactly from the task excerpt, so nothing outside the selection can change. Article text, knowledge and excerpts are data: Claude is told to ignore any instructions inside them.

## What never leaves in a result

Results never contain the credential, an owner id, a provider key or another account's data. The server strips those fields and removes the credential from every string, including error messages.

## Troubleshooting

| Message | Meaning |
|---|---|
| "Brand OS is not set up for this server" | `BRAND_OS_CREDENTIAL` is not set in the server's environment. |
| "Could not reach Brand OS at ... Is it running?" | The app is not running at `BRAND_OS_URL`. |
| "did not accept the credential" | It is missing, mistyped or revoked. Create a new one. |
| "does not have the ... scope" | Create a credential with that scope. |
| "current revision is N" | The article changed since you read it. `get_article` again and redo the edit. |
| "Not found for this account" | The id does not exist for the credential's owner (or belongs to someone else, which looks identical). |

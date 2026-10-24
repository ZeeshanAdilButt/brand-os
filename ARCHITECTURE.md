# Architecture

Engineering Brand OS (the product content-powerhouse is growing into) is a local-first, self-hostable, multi-tenant studio for technical articles and their distribution. The same code runs on one person's machine with no account and no AI key, and as a hosted service for many isolated users. Day 1 shipped the foundation described here, Day 2 added accounts, the tenant-scoped data layer and personal knowledge, Day 3 the article studio, Day 4 optional AI, agent access and the Claude Code MCP server, and Day 5 the technical publishing connectors; later days fill in the modules. See `DECISIONS.md` for why, and `TODO.md` for when.

## Modes

| | `MODE=local` (default) | `MODE=hosted` |
|---|---|---|
| Who | One person, one machine | Many users, one deployment |
| Account | None. A single implicit `local_owner` row, marked owner | Email and password sign-in, one `member` row per user |
| Database | Embedded Postgres (PGlite) in `DATA_DIR` | PostgreSQL server at `DATABASE_URL` |
| Migrations | Applied automatically on first use | Explicit deploy step: `pnpm db:migrate` |
| AI | Optional, off by default | Optional, per-user key only |
| Cost | Nothing to pay | Operator's hosting only |

The mode is read once from the environment by `apps/web/src/server/config.ts`. Everything below the config line is identical in both modes: one schema, one migration set, one query layer.

## Layout

```
apps/web/                 Next.js (App Router, TypeScript strict, Tailwind, shadcn/ui)
  src/app/(app)/          The studio behind the session check; (auth)/ holds sign-in and sign-up; api/ holds route handlers
  src/components/         Shell, empty states, shadcn/ui primitives
  src/server/
    config.ts             Env to validated config (mode, driver, data dir, app URL, auth secret, owner id)
    context.ts            AppContext (config, db, auth) for a request
    auth/                 Better Auth setup (hosted), session resolution, requireSessionUser
    http/                 Request guard and the JSON route handlers' logic
    db/                   schema.ts (Drizzle), client.ts (pglite or node-postgres), migrate.ts
    data/                 The data-access layer: forOwner(ownerId) and its repositories. Only code that queries tenant tables.
    actions/              The shared action layer (see below): knowledge, profile, articles, export, system, agent keys, AI providers, AI tasks and their runner
    ai/                   Provider adapters (OpenAI-compatible, Anthropic), key encryption, address rules, the context builder (privacy gate), result application, the event bus
    agent/                Agent key secrets and rate limits, and the views the agent API returns
    publishing/           Platform adapters (DEV.to, Hashnode), the shared request helper, lint, tag rules, hashes, the adapter registry and views
    connect/              The connection framework: validators, OAuth with PKCE, device flow, renewal under a lease, sealed bundles
  drizzle/                Generated SQL migrations (one set, both drivers)
  seed/                   owner.private.json (gitignored, never committed): the private owner seed
  test/                   Vitest: db, health, tokens, hygiene, auth, isolation, search, seed, source rules
packages/                 Phase 0, kept as the legacy single-user path (decision 32)
  core/ daemon/ client/ mcp/ cli/    Approval gate, dev.to and Buffer routes, dashboard, MCP, CLI
  brand-mcp/                         The brand-os MCP server for Claude Code: articles, knowledge, AI tasks and platform drafts over the agent API
scripts/setup-local.mjs   One-step local setup
```

It is a modular monolith: one deployable, internal modules with clear seams. No Redis, Kafka, Kubernetes or vector database. Long work (publishing retries, imports) runs in-process with rows in Postgres as the queue until measurement says otherwise.

## The shared action layer

Every capability is a function in `src/server/actions/`: input validated with Zod, an authenticated `owner` context in, a typed result out, an audit event written for anything that changes state. Three callers use the same functions and nothing else:

```
 Browser UI (server components, route handlers)  \
 Agent API /api/agent/* (bearer key), used by    >-->  actions/  -->  data/ (scopedX)  -->  db/
   the brand-os MCP server and Claude Code        |
 AI provider (optional, structured operations)   /
```

The rules that follow from this:

- UI, MCP and AI never import `db/` or `drizzle-orm` tables directly. They call actions.
- An AI call cannot do more than a user's click can: it goes through the same action, with `actor: 'ai'` in the audit trail.
- Every action after the first takes an `OwnerContext` (built only from a session by `sessionToOwner`) and accepts no owner id in its input. Day 1 had `getHealth()`; Day 2 added knowledge, profile and export. Later days add articles, drafts and publishing in the same shape.

## Tenant model

`users.id` is the owner id. Every other table carries `owner_id uuid not null references users(id)`, indexed with its most common sort key. Rules:

1. Only `src/server/data/` touches tenant tables. `forOwner(ownerId)` returns the repositories; every query inside is filtered by that owner id, and inserts set it last. The id is validated as a UUID so a malformed value cannot widen a query. A source-rule test fails the build on any other access.
2. Tests prove isolation (owner A cannot read, list, modify, search or publish owner B's rows). `test/isolation.test.ts` covers profiles, preferences, sources, items, search and export through the data layer and the route handlers; each new table adds the same tests.
3. Row level security is available in both engines (verified, see `DECISIONS.md`) but is not the primary boundary: the embedded engine connects as a superuser, which bypasses it. Hosted mode may add RLS under a non-superuser role as defense in depth.
4. The owner id comes only from the authenticated session (hosted) or the single local owner (local), never from request input or an MCP or AI argument.
5. Private owner data (the personal knowledge seed) is bound to the owner's user id, is read only from a gitignored file, lives in the database, and never enters git, fixtures or docs.

## Accounts and sessions

Local mode resolves every request to the `local_owner` row (a real user id, `is_owner` set). Hosted mode uses Better Auth (decision 11): `/api/auth/*` endpoints, an httpOnly SameSite=Lax session cookie, sessions stored in Postgres. `src/app/(app)/layout.tsx` redirects signed-out hosted visitors to `/sign-in`; route handlers answer 401. JSON route handlers also run a request guard (loopback host names in local mode, same-origin for mutations).

## Knowledge

`profiles` and `brand_preferences` (one row per owner), `knowledge_sources` and `knowledge_items` (one claim per row, with verification, confidence, confidentiality, a public-use flag and a review date). Search is a generated `tsvector` with a GIN index, ranked and highlighted in SQL, always inside the owner filter. `GET /api/export` returns the signed-in user's own rows as JSON.

## Article studio

`articles` (current content, metadata, `revision` for concurrency, generated search vector), `article_versions` (append-only snapshots), `assets` (file facts; bytes live behind the storage adapter) and `studio_settings` (the content folder). All four carry `owner_id` and are reached only through `forOwner(...).articles / .assets / .studioSettings`. Routes: `/api/articles` (list, search, create), `/api/articles/[id]` (get, save with `expectedRevision`, delete), `.../versions` (list, one, restore), `/api/articles/check-slug`, `/api/articles/import/{file,url,folder}`, `/api/assets` (upload, list) and `/api/assets/[id]` (authenticated, tenant-checked download). Pages: `/articles` (list), `/articles/import`, `/articles/[id]` (studio) and `/articles/[id]/read`.

The studio is a client component tree loaded after the page shell: CodeMirror editor, live preview, a side panel for details and history, and a save controller (`src/lib/autosave.ts`) that owns debouncing, retries and conflicts. Rendering is one shared pipeline (`src/lib/markdown/render.ts`) used by the preview and the reading view; Mermaid is drawn in the browser. Imports (`src/server/import/*`) parse files, fetch pages through an SSRF-checked fetcher and read a local folder; all of them end in `createImportedArticle`, which writes a draft and an `import` version. Decisions 18 to 23 explain the choices.

## Agent access and the agent API

A person creates named keys in Settings > Agent access, each with a scope list (`read`, `write_articles`, `ai_tasks`). The secret is 256 random bits, shown once, and only its SHA-256 hash is stored (`agent_credentials`), with a prefix for display, last use and a revoke time. `/api/agent/*` takes `Authorization: Bearer <secret>` and nothing else:

```
request -> host guard -> shape check -> hash lookup (the one lookup not scoped to an owner)
        -> revoked? -> per-key rate limit -> scope check -> action (as actor "agent") -> audit
```

The owner id comes from the key row and is never read from the path, query, body or headers. The routes call the same actions as the UI (`listArticles`, `saveArticle`, `listItems`, `submitTaskResult`), so validation, optimistic concurrency and audit are shared; an agent's saves are recorded with the version reason `agent`, whatever the body claims. Platform draft routes (prepare, stage privately, request approval, read status) exist; there is no route that approves, declines, publishes, checks, marks or connects, and a key cannot create keys or change providers (those actions refuse any actor but the signed-in owner). Failed attempts are slowed per client, requests are limited per key (in memory, per process), and every change and every use of a revoked key is in the owner's audit log.

## AI providers, the privacy gate and tasks

Providers are per user (`ai_providers`): `local` (Ollama or any OpenAI-compatible address), `api_key` (Anthropic, or an OpenAI-compatible service with the user's key), `claude_code_handoff` (the app runs nothing), and a reserved `local_cli_agent` slot that exists in the registry and cannot be selected. Keys are AES-256-GCM ciphertext bound to the owner and row, under a master key from `APP_SECRET` or, locally, a key file in `DATA_DIR`; the browser only ever sees the last four characters. Each provider has a trust level, `local` or `external`, derived from its kind and address (a local model on loopback or a private network is local; everything else is external), never typed in. A hosted server refuses local models and private addresses and calls user addresses through a fetch that resolves the name to a public address and connects to that address.

The context builder (`src/server/ai/context.ts`) is the privacy gate. A request carries the selected excerpt, the article's title, description and tags, and knowledge items that are relevant AND (the provider is local, OR the item is marked for public use, OR the person approved that item for this one task). An approval is made by reading the exact text in a dialog; the server rebuilds the text and refuses the task if its hash differs from what was shown. Article and note text is fenced as data with a nonce derived from the content, and marker-like text inside it is defanged.

An AI task (`ai_tasks`) records what was asked, the exact excerpt and the revision it was made for, the provider, the exact prompt, the status (`pending`, `running`, `needs_review`, `accepted`, `rejected`, `failed`), the structured result and token usage (estimated unless the provider reports it; a cost is never invented). A provider that runs tasks executes them in the background (Next's `after`): bounded by a timeout, cancellable through an in-process controller, one retry for transient failures only, answered from an earlier identical request by hash, and blocked by an optional monthly soft cap counted in estimated tokens. Every result, from a model or from Claude Code, goes through one validation (`src/lib/ai-ops.ts`): a discriminated union of five operations, restricted per task kind, with size limits and no HTML, and `replace_range` may only touch text inside the task's own excerpt. Accepting re-checks the live article (a result whose original text changed is flagged stale and refused), then saves a version with the reason `ai_accept`. Nothing is applied any other way.

Status changes are published on an in-process bus right after the database commit and reach the browser over server-sent events (`/api/ai/events`), scoped to the signed-in owner; the studio falls back to polling if the stream cannot open. The bus and the per-key limiter live in the server process, which is right for local mode and one hosted instance; several instances would need a shared channel.

## The brand-os MCP server

`packages/brand-mcp` is a stdio MCP server (`@modelcontextprotocol/sdk` 1.32.1) that calls `/api/agent/*` with a key from `BRAND_OS_CREDENTIAL` and an address from `BRAND_OS_URL`. Fifteen typed tools: profile, knowledge search, list, read, create and update articles (update needs the revision read), list and read AI tasks, submit a task result, and six for platform drafts (create, list, get, stage a private copy, request approval, read status). It has no approve, decline, publish, check or hand-off tool. Results drop owner ids and key-like fields and remove the key from every string. It keeps its own copy of the result rules so a bad result is refused before it is sent; a test fails if that copy ever differs from the app's. Registration and scopes: `docs/brand-os-mcp.md`.

## Local companion for browser users (planned, not built)

A browser-based hosted user cannot let a hosted server reach their machine, and the hosted server must never run the user's `claude` binary or use their subscription. If a user wants local tooling anyway, the planned answer is an optional companion program the user installs and runs themselves. Its design constraints, written down now so nothing is built against them by accident:

- **Pairing.** The user starts the companion, which shows a short one-time code; the user enters it in the web app while signed in. The pairing creates an agent key (Settings > Agent access) with the narrowest scopes the user picks, held only by the companion on that machine. The code expires in minutes and works once. Unpairing revokes the key.
- **Direction.** The companion connects out to the app's agent API; the hosted server never connects in. There is no inbound port, no tunnel and no way for the server to start a process.
- **May.** Serve the `brand-os` MCP tools to the user's own Claude Code on that machine, read and write the user's own articles within the key's scopes, and complete AI tasks the user handed off.
- **May not.** Publish, approve or schedule anything; read files outside a folder the user names; hold platform tokens or Claude credentials; send data anywhere except the user's own Brand OS address; run commands the web app sends it.
- **Same rules.** Everything it does goes through the agent API and the shared action layer, so isolation, validation and audit are unchanged.

## Adapter seams

Three seams keep providers replaceable. Storage, AI and publishing are built.

| Seam | Interface (sketch) | Implementations |
|---|---|---|
| Storage | put, get, delete, signed or local URL for article assets | Local folder under `DATA_DIR` (default); S3-compatible (hosted, later) |
| AI | `complete({ system, user, maxOutputTokens, timeoutMs, signal }) -> { text, usage, model, truncated }`; errors are `AdapterError` with a kind and a redacted message; never required | None (default); OpenAI-compatible chat completions (Ollama, LM Studio, a user-keyed service); Anthropic Messages API with the user's key; Claude Code hand-off (no adapter: tasks wait for the agent API); `local_cli_agent` reserved |
| Publishing | `id`, `info` (auth kind, capabilities, verification level), `adapt`, `validate`, `preview`, `health`, `stage` (private), `publish`, `check` (read-only); errors are `PlatformError` with a kind and an ambiguous flag | DEV.to and Hashnode (Day 5); personal-site change (Day 6); Medium as "prepare and open" |

Verified facts and limits for each provider are in `INTEGRATIONS.md`.

## Approval boundaries

- Nothing is published, posted, scheduled or sent without the owner's explicit approval of that exact action. One approval covers one action, never a batch relayed by another session.
- Publish actions in the web app go through the approval model in `src/server/actions/publishing.ts` and `src/server/data/publishing.ts` (decisions 32 and 33): the Phase 0 gate's invariants rebuilt on Postgres, per owner. The web app, the agent API and MCP can prepare drafts, stage private copies and request approval; only the signed-in owner, in the browser, can approve.
- AI output is a proposal: structured operations shown as a diff, applied only when the owner accepts.
- Credentials are never read from `~/.claude` or any Claude login. The only Anthropic credential accepted is an API key the user saved on purpose.
- Provider keys are stored per user, encrypted with an app-level key, shown as last four characters only, never logged.

## Publishing

Four tenant tables: `platform_connections` (one per platform, key encrypted and bound to the row), `platform_drafts` (the adapted article, the exact payload and its hash, lint, the article revision and source hash it came from, the remote id and link), `approvals` (single use, hash bound, 30 minutes) and `publish_attempts` (every stage, publish, check and manual resolution with a redacted message). All are reached through `forOwner(...).connections` and `.platformDrafts`.

```
prepare -> (lint) -> stage (private copy) -> request approval -> approve and publish -> published
   |                    |                          |                    |  one transaction:
   |                    |                          |                    |  consume approval + status publishing
   v                    v                          v                    v  then ONE adapter call
 source_changed if the article changes at any point before publishing; failed or unknown after
```

`authorizePublish` is the only code that moves a draft to `publishing`. It re-checks, inside one transaction, the draft status, the staged remote copy, the article's source hash, the connection state, and the approval (pending, unexpired, same payload hash), consumes the approval and writes a `started` attempt. A partial unique index on (owner, platform, payload hash) while `publishing`, `unknown` or `published` stops a second draft with the same payload. The adapter is then called once. Routes: `/api/connections`, `/api/articles/[id]/destinations`, `/api/platform-drafts` (prepare, read, stage, request-approval, check, mark) and `/api/approvals/[id]/approve|decline`; the agent routes under `/api/agent/platform-drafts` stop at request-approval and status.

### Destinations, the Publishing screen and the approval queue (Day 6)

Seven more tables serve the composer, all tenant scoped through `forOwner(...)`: `article_destinations` (which destinations an article has, in the owner's order), `site_settings` (the personal site's address, repository, base branch, path template and front matter mapping), `canonical_checks` (the last read-only look at an article's canonical page, one per article and address), `integration_secrets` (encrypted values saved for platforms that are not built yet, never read back), and new columns on `platform_drafts` (`generated_payload`, `extras`, `remote_info`, `published_via`, `edited_at`, `edit_count`), `approvals` (`kind`: publish or manual) and `ai_tasks` (`draft_id`, `draft_hash`, `platform`).

The catalog (`lib/catalog.ts`, 13 destinations) and the directory (`lib/directory.ts`, every platform on the roadmap) have no server imports, so the browser, the previews and the server share them. Three destinations have real adapters (DEV.to, Hashnode, GitHub for the site); the others share a content adapter that adapts and lints and refuses every network call. `isPublishable` gates stage, approve, publish, check and connect.

Screens: **Publishing** (`/publishing`) is one page with the article picker, the platform selector and live previews (`components/publish/workspace`); **Approve** (`/articles/<id>/publish`) is the one-at-a-time queue and the results; the **Composer** (`?view=composer`) is the expert view with the original, every destination and the checks side by side. All three drive the same hook, `usePublish`, which calls the same routes; none of them can approve more than one post (the approve route takes one approval id and only the ticked boxes). Pure logic lives in `lib`: `next-step` (the one next action, computed from real state), `recommend`, `publish-workspace` (article search, selectable rows, progress), `publish-queue`, `wizard-state`, `chips`, `commands`.

The personal site goes through `adapters/github-site.ts`: base sha, target file, a new branch `brand-os/<slug>-<hash8>`, one committed file, one pull request; never the base branch, never a merge. The canonical check reuses the URL import fetcher (`publishing/canonical.ts`).

### Connections: one framework for every platform

`lib/connectors` holds one validated definition per directory entry (45) and the pure state function; `server/connect` holds what runs: `validators.ts` (one free read-only `validate()` per platform, with an injected `fetch`), `oauth.ts` (authorization code with PKCE, the token endpoint, renewal), `device.ts` (the code sign-in), `tokens.ts` (renewal under a lease), `bundle.ts` (what a connection stores, sealed like every other key), `request.ts` (the shared request rules) and `env.ts` (the seams tests replace: network, clock, limits, randomness). `actions/connect.ts` is the only caller, and only for the signed-in owner; `http/connect-handlers.ts` and `app/api/connect/*` are the browser routes.

```
Connect drawer -> POST /api/connect/<id>/fields   -> validate() -> sealed bundle in platform_connections
               -> POST /api/connect/<id>/start    -> connect_flows (state hash, session hash, sealed verifier) -> platform
platform       -> GET  /api/connect/<id>/callback -> spend state once -> exchange code -> validate() -> sealed bundle
               -> POST /api/connect/<id>/device   -> connect_flows (sealed device code) ... poll at the platform's interval
Test           -> renew under a lease if needed   -> validate() -> status, who, error code, last checked
Disconnect     -> official revoke where one exists -> delete the stored secret
```

Connections and the publishing adapters share `platform_connections`; the three with an adapter keep a plain sealed key, every other connector a sealed bundle (decisions 49 to 53). The OAuth app is the owner's own (`integration_secrets`, kinds `oauth_client` and `device_client`) or, hosted, Brand OS's from the environment. A `connect_flows` row exists only while a sign-in is in progress. Nothing here is reachable from the agent API, an agent key or an MCP tool.

## Phase 0 and the new stack (two stores)

Phase 0 is a separate local program: a daemon with SQLite (`cph.db`), the approval gate, OS keyring secrets, dev.to and Buffer routes, an MCP server and a dashboard. The new web app has its own Postgres. They do not share data. Day 5 did not couple them: the web app has its own publishing path (decision 32) and the daemon stays as the legacy single-user path until Day 7 decides whether to reconcile or retire it.

## Observability

`GET /api/health` returns `{ status, mode, db: { ok, driver, latencyMs, schema } }`, HTTP 503 when the database is unreachable. The top-bar chip polls it; Settings shows the detail. Audit events (`audit_events`) record who did what, per owner.
